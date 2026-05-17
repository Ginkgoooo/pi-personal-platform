/**
 * pi-personal-platform / handoff
 *
 * 用途：下班或切换电脑前一条命令收齐"今天我留下了什么、明天/另一台电脑接手要怎么继续"，
 * 把摘要送回模型，让它给出交接说明，并附带记忆导出脚本提醒。
 *
 * 输出包含：
 * - cwd 与 projectId
 * - Git 今日工作：当天 00:00 起的本地 commit、未提交 status、numstat 摘要
 * - 当前项目最近 decision / note
 * - 记忆导出脚本提醒（不自动执行）
 *
 * 稳定性原则：
 * - 所有外部命令（git）都加超时和 try-catch，单项失败不阻断整体输出
 * - 只读 ~/.pi/memory/store.jsonl
 * - 不写入任何文件、不自动导出，导出由主公显式触发
 * - 模型忙碌时拒绝执行，避免破坏当前流式回复
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
  projectId?: string
  deleted: boolean
  createdAt: string
  updatedAt: string
}

interface ProjectIdentity {
  cwd: string
  normalizedCwd: string
  projectId?: string
}

interface GitHandoffSnapshot {
  available: boolean
  branch?: string
  todayCommits?: string
  uncommittedStatus?: string
  uncommittedStatusTruncated: boolean
  uncommittedSummary?: string
  hasUncommitted: boolean
  error?: string
}

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 1500
const STORE_PATH = join(homedir(), '.pi', 'memory', 'store.jsonl')
const DECISION_RECENT_LIMIT = 3
const NOTE_RECENT_LIMIT = 3
const PREVIEW_LIMIT = 160
const STATUS_LINE_LIMIT = 30

// ==================== 路径 / 项目身份 ====================

function normalizeProjectPath(projectPath: string | undefined): string {
  const normalized = (projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized.replace(/^\/([a-z])\//, '$1:/')
}

function normalizeProjectId(projectId: string | undefined): string | undefined {
  const normalized = (projectId || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
  return normalized || undefined
}

function normalizeGitRemoteUrl(remoteUrl: string): string | undefined {
  const raw = remoteUrl.trim()
  if (!raw) return undefined

  const scpLike = raw.match(/^(?:[^@/]+@)?([^:]+):(.+)$/)
  if (scpLike && !raw.includes('://') && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return normalizeProjectId(`${scpLike[1]}/${scpLike[2]}`)
  }

  try {
    const url = new URL(raw)
    if (!url.hostname) return undefined
    return normalizeProjectId(`${url.hostname}${url.pathname}`)
  } catch {
    return undefined
  }
}

async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
  const identity: ProjectIdentity = { cwd, normalizedCwd: normalizeProjectPath(cwd) }
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: GIT_TIMEOUT_MS,
    })
    const projectId = normalizeGitRemoteUrl(stdout)
    if (projectId) identity.projectId = projectId
  } catch {
    // 无 git / 非 git 仓库 / 没有 origin 都正常回退 cwd
  }
  return identity
}

// ==================== Git handoff snapshot ====================

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

/**
 * 当天 00:00 的 ISO 时间戳，用于 git log --since。
 * 这里用本地时区的"今天 00:00"，主公更直观。
 */
function todayMidnightIso(): string {
  const now = new Date()
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  return local.toISOString()
}

async function collectGitHandoff(cwd: string): Promise<GitHandoffSnapshot> {
  try {
    await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch (err) {
    return {
      available: false,
      uncommittedStatusTruncated: false,
      hasUncommitted: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const snapshot: GitHandoffSnapshot = {
    available: true,
    uncommittedStatusTruncated: false,
    hasUncommitted: false,
  }

  try {
    snapshot.branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || '(detached)'
  } catch (err) {
    snapshot.branch = '(unknown)'
    snapshot.error = err instanceof Error ? err.message : String(err)
  }

  // 今日本地 commit；只看当前分支的 HEAD 历史
  try {
    const since = todayMidnightIso()
    const log = (
      await runGit(cwd, ['log', `--since=${since}`, '--pretty=format:%h %ad %an %s', '--date=iso-local'])
    ).trim()
    snapshot.todayCommits = log || '(no commits today on current branch)'
  } catch (err) {
    snapshot.todayCommits = '(unavailable)'
    snapshot.error = err instanceof Error ? err.message : String(err)
  }

  // 未提交改动 status
  try {
    const status = (await runGit(cwd, ['status', '--porcelain=v1'])).replace(/\r?\n$/, '')
    if (!status) {
      snapshot.uncommittedStatus = '(clean)'
      snapshot.hasUncommitted = false
    } else {
      const lines = status.split('\n')
      snapshot.hasUncommitted = true
      if (lines.length > STATUS_LINE_LIMIT) {
        snapshot.uncommittedStatus = lines.slice(0, STATUS_LINE_LIMIT).join('\n')
        snapshot.uncommittedStatusTruncated = true
      } else {
        snapshot.uncommittedStatus = lines.join('\n')
      }
    }
  } catch (err) {
    snapshot.uncommittedStatus = '(unavailable)'
    snapshot.error = err instanceof Error ? err.message : String(err)
  }

  // 工作树 vs HEAD 的 numstat 摘要：包含已暂存 + 未暂存的所有改动行数
  if (snapshot.hasUncommitted) {
    try {
      const numstat = (await runGit(cwd, ['diff', 'HEAD', '--numstat'])).trim()
      if (numstat) {
        const lines = numstat.split('\n')
        let added = 0
        let removed = 0
        for (const line of lines) {
          const parts = line.split('\t')
          const a = Number(parts[0])
          const r = Number(parts[1])
          if (Number.isFinite(a)) added += a
          if (Number.isFinite(r)) removed += r
        }
        snapshot.uncommittedSummary = `${lines.length} file(s) changed, +${added} / -${removed} lines`
      } else {
        // 可能只有 untracked 文件；status 已经反映出来，这里保持空
        snapshot.uncommittedSummary = '(only untracked files; see status above)'
      }
    } catch (err) {
      snapshot.uncommittedSummary = '(unavailable)'
      snapshot.error = err instanceof Error ? err.message : String(err)
    }
  }

  return snapshot
}

// ==================== 记忆加载 ====================

async function loadAllMemories(): Promise<MemoryEntry[]> {
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
      // 单行损坏跳过
    }
  }
  return entries
}

function isCurrentProjectMemory(entry: MemoryEntry, identity: ProjectIdentity): boolean {
  if (entry.scope !== 'project') return false
  const entryProjectId = normalizeProjectId(entry.projectId)
  if (identity.projectId && entryProjectId) return entryProjectId === identity.projectId
  return normalizeProjectPath(entry.project) === identity.normalizedCwd
}

function preview(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}...` : text
}

function sortByUpdatedAtDesc(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

interface MemorySnapshot {
  decisions: MemoryEntry[]
  notes: MemoryEntry[]
}

function selectMemorySnapshot(entries: MemoryEntry[], identity: ProjectIdentity): MemorySnapshot {
  const projectActive = entries
    .filter((entry) => !entry.deleted)
    .filter((entry) => isCurrentProjectMemory(entry, identity))
  const decisions = sortByUpdatedAtDesc(projectActive.filter((entry) => entry.category === 'decision')).slice(
    0,
    DECISION_RECENT_LIMIT,
  )
  const notes = sortByUpdatedAtDesc(projectActive.filter((entry) => entry.category === 'note')).slice(
    0,
    NOTE_RECENT_LIMIT,
  )
  return { decisions, notes }
}

// ==================== 报告格式化 ====================

function formatMemoryLine(entry: MemoryEntry): string {
  return `- [${entry.category}] ${entry.key} (id=${entry.id}, updatedAt=${entry.updatedAt}): ${preview(entry.value)}`
}

function formatMemorySection(title: string, entries: MemoryEntry[]): string {
  if (entries.length === 0) return `## ${title}\n(none)`
  return `## ${title}\n${entries.map(formatMemoryLine).join('\n')}`
}

function formatGitSection(snapshot: GitHandoffSnapshot): string {
  if (!snapshot.available) {
    return ['## Git', '(not a git repository or git unavailable)'].join('\n')
  }
  const parts: string[] = ['## Git']
  parts.push(`branch: ${snapshot.branch || '(unknown)'}`)
  parts.push('')
  parts.push("today's commits (since local 00:00, current branch):")
  parts.push('```')
  parts.push(snapshot.todayCommits || '(unavailable)')
  parts.push('```')
  parts.push('')
  parts.push(
    snapshot.hasUncommitted
      ? `uncommitted changes: yes${snapshot.uncommittedSummary ? ` — ${snapshot.uncommittedSummary}` : ''}`
      : 'uncommitted changes: no (working tree clean)',
  )
  parts.push('')
  parts.push('status (porcelain):')
  parts.push('```')
  parts.push(snapshot.uncommittedStatus || '(unavailable)')
  if (snapshot.uncommittedStatusTruncated) {
    parts.push(`... (truncated to ${STATUS_LINE_LIMIT} lines, run \`git status\` for full output)`)
  }
  parts.push('```')
  return parts.join('\n')
}

function buildHandoffReport(
  identity: ProjectIdentity,
  git: GitHandoffSnapshot,
  memory: MemorySnapshot,
): string {
  const parts: string[] = [
    '# Project Handoff Snapshot',
    '',
    `cwd: ${identity.cwd}`,
    `projectId: ${identity.projectId || '(none)'}`,
    `generated: ${new Date().toISOString()}`,
    '',
    formatGitSection(git),
    '',
    formatMemorySection('Recent Decisions', memory.decisions),
    '',
    formatMemorySection('Recent Notes', memory.notes),
  ]
  return parts.join('\n')
}

const HANDOFF_INSTRUCTION = [
  '请基于以上"项目交接快照"为主公生成一份简短的交接说明，分三段：',
  '1. 今日完成：根据"today\'s commits"以及（若有）相关 note/decision，列出今天明确完成的事项；若今天没有 commit，请明说"今日无 commit"，避免凭空推断。',
  '2. 未提交/待续：基于 status 与 uncommitted summary 总结现在工作树留了哪些改动；如果是 clean 也明说。',
  '3. 下次接手建议：给 2-3 条具体动作，按优先级排序，明确"切换到另一台电脑后第一步做什么"。',
  '不要建议主公立刻 commit 或 push；是否提交由主公决定。',
].join('\n')

const MEMORY_EXPORT_REMINDER = [
  '',
  '---',
  'Memory export reminder:',
  '- 切换电脑前请运行 `scripts/export-memory.ps1` 把 ~/.pi/memory 打包，到另一台电脑 `scripts/import-memory.ps1` 导入。',
  '- 该步骤本扩展不会自动执行。',
].join('\n')

// ==================== 命令注册 ====================

export default function handoff(pi: ExtensionAPI): void {
  pi.registerCommand('handoff', {
    description:
      "Summarize today's git work and recent project memories, then ask the model for a handoff note (does not auto-export memory)",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd || process.cwd()

      if (!ctx.isIdle()) {
        ctx.ui.notify('Agent is busy. Run /handoff after the current response finishes.', 'warning')
        return
      }

      const [identity, git, allMemories] = await Promise.all([
        resolveProjectIdentity(cwd),
        collectGitHandoff(cwd),
        loadAllMemories(),
      ])
      const memory = selectMemorySnapshot(allMemories, identity)

      const report = buildHandoffReport(identity, git, memory)
      const reportWithReminder = `${report}${MEMORY_EXPORT_REMINDER}`

      ctx.ui.notify(reportWithReminder, 'info')
      pi.sendUserMessage(`${reportWithReminder}\n\n${HANDOFF_INSTRUCTION}`)
    },
  })
}
