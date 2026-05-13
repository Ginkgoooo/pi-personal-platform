/**
 * pi-personal-platform / auto-memory-injector
 *
 * 用途：在每次 agent 开始推理前，自动把少量本地持久记忆摘要追加到 system prompt。
 *
 * 稳定性原则：
 * - 只读 ~/.pi/memory/store.jsonl，不自动创建目录或文件
 * - 只注入摘要 preview，不注入完整 value，避免上下文膨胀
 * - 项目记忆只注入当前 cwd 匹配的 scope=project 记忆
 * - global 记忆少量注入，作为跨项目个人偏好/事实参考
 * - 读取失败、单行损坏、无可见记忆时均静默跳过，不阻塞会话
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type Category = 'decision' | 'preference' | 'fact' | 'note' | 'lesson' | 'other'
type Scope = 'global' | 'project'

interface MemoryEntry {
  id: string
  category: Category
  key: string
  value: string
  scope: Scope
  project?: string
  deleted: boolean
  createdAt: string
  updatedAt: string
}

const STORE_PATH = join(homedir(), '.pi', 'memory', 'store.jsonl')
const STATUS_KEY = 'auto-memory'
const PROJECT_MEMORY_LIMIT = 5
const GLOBAL_MEMORY_LIMIT = 3
const PREVIEW_LIMIT = 120

/** 读取所有记忆；失败时返回空数组，避免阻塞会话启动 */
async function loadAll(): Promise<MemoryEntry[]> {
  let raw = ''
  try {
    raw = await readFile(STORE_PATH, 'utf8')
  } catch {
    return []
  }

  const entries: MemoryEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as MemoryEntry)
    } catch {
      // 单行损坏时跳过，避免整个记忆库不可用
    }
  }
  return entries
}

/** 归一化项目路径，兼容 Windows / Git Bash / MSYS 路径写法 */
function normalizeProjectPath(projectPath: string | undefined): string {
  const normalized = (projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized.replace(/^\/([a-z])\//, '$1:/')
}

/** 判断记忆是否属于当前 cwd */
function isCurrentProjectMemory(entry: MemoryEntry, cwd: string): boolean {
  return entry.scope === 'project' && normalizeProjectPath(entry.project) === normalizeProjectPath(cwd)
}

function preview(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}...` : text
}

function sortByUpdatedAtDesc(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function selectMemories(entries: MemoryEntry[], cwd: string): { projectMemories: MemoryEntry[]; globalMemories: MemoryEntry[] } {
  const activeEntries = entries.filter((entry) => !entry.deleted)
  const projectMemories = sortByUpdatedAtDesc(activeEntries.filter((entry) => isCurrentProjectMemory(entry, cwd))).slice(
    0,
    PROJECT_MEMORY_LIMIT,
  )
  const globalMemories = sortByUpdatedAtDesc(activeEntries.filter((entry) => entry.scope === 'global')).slice(
    0,
    GLOBAL_MEMORY_LIMIT,
  )

  return { projectMemories, globalMemories }
}

function formatMemoryLine(entry: MemoryEntry): string {
  return `- [${entry.category}] ${entry.key} (id=${entry.id}, updatedAt=${entry.updatedAt}): ${preview(entry.value)}`
}

/** 包装为 system prompt 追加段 */
function wrapAsAppendSection(projectMemories: MemoryEntry[], globalMemories: MemoryEntry[]): string | undefined {
  if (projectMemories.length === 0 && globalMemories.length === 0) return undefined

  const parts: string[] = [
    '# Local Memory Context',
    '',
    '以下是本地持久记忆摘要，仅供参考。若与主公当前指令冲突，以当前指令为准；若需要完整正文，可使用 /memory <query> 或 /memory list 检索。',
  ]

  if (projectMemories.length > 0) {
    parts.push('', '## Current Project Memories', ...projectMemories.map(formatMemoryLine))
  }

  if (globalMemories.length > 0) {
    parts.push('', '## Global Memories', ...globalMemories.map(formatMemoryLine))
  }

  return `\n\n${parts.join('\n')}\n`
}

function buildStatusLabel(projectCount: number, globalCount: number): string | undefined {
  // 状态栏避免使用 emoji：部分终端会显示为乱码或重复图标
  if (projectCount > 0 && globalCount > 0) return `Memory P${projectCount}+G${globalCount}`
  if (projectCount > 0) return `Memory P${projectCount}`
  if (globalCount > 0) return `Memory G${globalCount}`
  return undefined
}

/** 安全设置/清除 TUI 状态行 */
function safeSetStatus(ctx: { ui?: { setStatus?: (key: string, value: string | undefined) => void } }, value: string | undefined): void {
  try {
    ctx.ui?.setStatus?.(STATUS_KEY, value)
  } catch {
    // 状态行属于 UI 表层信息，失败不影响主流程
  }
}

async function refreshMemoryStatus(ctx: { cwd?: string; ui?: { setStatus?: (key: string, value: string | undefined) => void } }): Promise<void> {
  const entries = await loadAll()
  const { projectMemories, globalMemories } = selectMemories(entries, ctx.cwd || process.cwd())
  safeSetStatus(ctx, buildStatusLabel(projectMemories.length, globalMemories.length))
}

export default function autoMemoryInjector(pi: ExtensionAPI): void {
  // session_start 时先刷新状态行；真正的 prompt 注入仍在 before_agent_start 中完成
  pi.on('session_start', async (_event, ctx) => {
    await refreshMemoryStatus(ctx)
  })

  pi.on('before_agent_start', async (event, ctx) => {
    const opts = event.systemPromptOptions
    const cwd = opts && opts.cwd ? opts.cwd : ctx.cwd || process.cwd()
    const entries = await loadAll()
    const { projectMemories, globalMemories } = selectMemories(entries, cwd)
    const appendSection = wrapAsAppendSection(projectMemories, globalMemories)

    safeSetStatus(ctx, buildStatusLabel(projectMemories.length, globalMemories.length))

    if (!appendSection) return

    return {
      systemPrompt: event.systemPrompt + appendSection,
    }
  })

  pi.on('session_shutdown', (_event, ctx) => {
    safeSetStatus(ctx, undefined)
  })
}
