/**
 * pi-personal-platform / memory-tool
 *
 * 稳态方案：
 * - remember：LLM 工具，已验证可用，用于写入持久记忆
 * - /memory ：本地斜杠命令，不走 LLM tool schema，只检索当前项目记忆并把结果送回对话
 *
 * 说明：
 * - 之前尝试把 recall/list_memory 也做成 custom tool 时，cc-switch 上游出现无响应 / EOF。
 * - 因此将检索能力下沉为本地命令，绕开上游 tool schema 兼容问题。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

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

interface RememberParams {
  category: Category
  key: string
  value: string
  scope?: Scope
}

interface MemoryQueryParams {
  query: string
  limit?: number
}

const MEMORY_DIR = join(homedir(), '.pi', 'memory')
const STORE_PATH = join(MEMORY_DIR, 'store.jsonl')
const CATEGORY_VALUES = ['decision', 'preference', 'fact', 'note', 'lesson', 'other']

/** 确保存储目录存在 */
async function ensureMemoryDir(): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true })
}

/** 读取所有记忆；文件不存在时返回空数组 */
async function loadAll(): Promise<MemoryEntry[]> {
  let raw = ''
  try {
    raw = await readFile(STORE_PATH, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
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

/** 原子化保存全部记忆 */
async function saveAll(entries: MemoryEntry[]): Promise<void> {
  await ensureMemoryDir()
  const content = entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : ''
  const tmpPath = `${STORE_PATH}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, STORE_PATH)
}

function nowIso(): string {
  return new Date().toISOString()
}

function generateId(): string {
  return `mem_${Date.now()}_${randomBytes(3).toString('hex')}`
}

function normalizeCategory(category: unknown): Category {
  return typeof category === 'string' && CATEGORY_VALUES.includes(category) ? (category as Category) : 'other'
}

function normalizeScope(scope: unknown): Scope {
  return scope === 'global' ? 'global' : 'project'
}

/**
 * 归一化项目路径用于比较。
 *
 * Windows 环境下 cwd 可能出现 `D:\\dir` 或 `D:/dir` 两种形式；
 * 严格按当前项目检索时必须先归一化，避免同一项目因斜杠差异查不到记忆。
 */
function normalizeProjectPath(projectPath: string | undefined): string {
  return (projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 判断记忆是否属于当前 cwd。
 *
 * 当前阶段按主公要求：每个项目只查自己的项目级记忆。
 * 即使是 global 记忆，也不在 /memory 中自动返回，避免跨项目串扰。
 */
function isVisibleMemory(entry: MemoryEntry, cwd: string): boolean {
  return entry.scope === 'project' && normalizeProjectPath(entry.project) === normalizeProjectPath(cwd)
}

/** 写入或更新记忆 */
async function rememberOp(params: RememberParams, cwd: string): Promise<{ id: string; action: 'created' | 'updated' }> {
  const scope = normalizeScope(params.scope)
  const category = normalizeCategory(params.category)
  const project = scope === 'project' ? cwd : undefined
  const now = nowIso()

  return withFileMutationQueue(STORE_PATH, async () => {
    const entries = await loadAll()
    const index = entries.findIndex((entry) => {
      if (entry.deleted) return false
      if (entry.category !== category) return false
      if (entry.key !== params.key) return false
      if (entry.scope !== scope) return false
      return scope === 'global' ? !entry.project : normalizeProjectPath(entry.project) === normalizeProjectPath(project)
    })

    if (index >= 0) {
      entries[index].value = params.value
      entries[index].updatedAt = now
      await saveAll(entries)
      return { id: entries[index].id, action: 'updated' }
    }

    const id = generateId()
    entries.push({
      id,
      category,
      key: params.key,
      value: params.value,
      scope,
      project,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    })
    await saveAll(entries)
    return { id, action: 'created' }
  })
}

/**
 * 检索记忆，供 /memory 命令使用。
 * 默认只看当前项目自己的 project 记忆，避免跨项目串扰。
 */
async function queryMemory(params: MemoryQueryParams, cwd: string): Promise<MemoryEntry[]> {
  const query = params.query.trim().toLowerCase()
  const limit = Math.min(Math.max(params.limit || 10, 1), 30)
  const entries = await loadAll()

  return entries
    .filter((entry) => !entry.deleted)
    .filter((entry) => isVisibleMemory(entry, cwd))
    .filter((entry) => {
      if (!query) return true
      return entry.key.toLowerCase().includes(query) || entry.value.toLowerCase().includes(query)
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

/** 格式化 /memory 检索结果 */
function formatMemoryForPrompt(entries: MemoryEntry[]): string {
  return entries
    .map((entry, index) => {
      const scopeLabel = entry.scope === 'project' ? `project:${entry.project || '?'}` : 'global'
      return `[${index + 1}] id=${entry.id}\ncategory=${entry.category}\nkey=${entry.key}\nscope=${scopeLabel}\nupdatedAt=${entry.updatedAt}\nvalue=${entry.value}`
    })
    .join('\n\n')
}

export default function memoryTool(pi: ExtensionAPI): void {
  // /memory：本地检索命令，不经过 LLM tool schema，且只检索当前项目自己的 project 记忆
  pi.registerCommand('memory', {
    description: 'Search local persistent memories and send the result back into the conversation',
    handler: async (args, ctx) => {
      const query = args.trim()
      const hits = await queryMemory({ query, limit: 10 }, ctx.cwd || process.cwd())

      if (hits.length === 0) {
        ctx.ui.notify(query ? `No memory matched: ${query}` : 'No visible memory found', 'info')
        return
      }

      const title = query ? `本地记忆检索结果（query=${query}）` : '本地近期记忆'
      const body = formatMemoryForPrompt(hits)

      if (!ctx.isIdle()) {
        ctx.ui.notify('Agent is busy. Run /memory after the current response finishes.', 'warning')
        return
      }

      // 把检索结果作为用户消息送回模型，由模型基于本地记忆继续回答主公
      pi.sendUserMessage(`${title}\n\n${body}\n\n请基于以上本地记忆回答主公，并引用相关 key 或 id。`)
    },
  })

  // remember：持久化写入工具，已由主公验证可用
  pi.registerTool({
    name: 'remember',
    label: 'Remember',
    description:
      'Persist one memory for future sessions. Use it when the user explicitly asks you to remember something, states a preference, or makes a clear decision.',
    promptSnippet: 'remember: persist one user preference, decision, fact, note, or lesson across sessions',
    promptGuidelines: [
      'Use remember when the user explicitly asks you to remember something, states a preference, or makes a clear decision.',
      'After remember succeeds, briefly tell the user the saved category, key, and scope.',
      'Use scope=project for project-specific memories and scope=global for cross-project personal preferences.',
    ],
    parameters: Type.Object({
      category: Type.String({ description: 'One of: decision, preference, fact, note, lesson, other.' }),
      key: Type.String({ description: 'Short stable identifier. Same category/key/scope overwrites previous memory.' }),
      value: Type.String({ description: 'Memory content in plain text.' }),
      scope: Type.Optional(Type.String({ description: 'project or global. Default is project.' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal && signal.aborted) {
        return { content: [{ type: 'text', text: 'Cancelled' }], details: {} }
      }

      const raw = params as RememberParams
      const category = normalizeCategory(raw.category)
      const scope = normalizeScope(raw.scope)
      const result = await rememberOp({ category, key: raw.key, value: raw.value, scope }, ctx.cwd || process.cwd())

      return {
        content: [
          {
            type: 'text',
            text: `Memory ${result.action}: category=${category}, key=${raw.key}, scope=${scope}, id=${result.id}`,
          },
        ],
        details: result,
      }
    },
  })
}
