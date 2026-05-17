/**
 * pi-personal-platform / resume-project
 *
 * 用途：开工时一条命令收齐"我现在在哪、最近干了什么、记忆和决策提示什么"，
 * 把摘要送回模型，让它给出"下一步建议"。
 *
 * 输出包含：
 * - cwd 与 projectId
 * - Git：当前分支、porcelain 状态（截断）、最近 5 条 commit
 * - 当前项目最近记忆（按 updatedAt 倒序）
 * - 最近 decision（项目内）
 * - 最近 note（项目内）
 *
 * 稳定性原则：
 * - 所有外部命令（git）都加超时和 try-catch，单项失败不阻断整体输出
 * - 只读 ~/.pi/memory/store.jsonl，与 memory-tool / auto-memory-injector 解耦
 * - 不写入任何文件、不修改任何记忆，纯只读命令
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

interface GitSnapshot {
  available: boolean
  branch?: string
  status?: string
  statusTruncated: boolean
  recentCommits?: string
  error?: string
}

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 1500
const STORE_PATH = join(homedir(), '.pi', 'memory', 'store.jsonl')
const PROJECT_RECENT_LIMIT = 5
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

// ==================== Git snapshot ====================

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

/**
 * 抓取 Git 现状摘要。
 * 任一子项失败都尽量保留其他成功项，最终给到模型一个尽可能完整的快照。
 */
async function collectGitSnapshot(cwd: string): Promise<GitSnapshot> {
  // 先确认是不是 Git 仓库；不是就直接返回 available=false
  try {
    await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch (err) {
    return { available: false, statusTruncated: false, error: err instanceof Error ? err.message : String(err) }
  }

  const snapshot: GitSnapshot = { available: true, statusTruncated: false }

  try {
    const branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    snapshot.branch = branch || '(detached)'
  } catch (err) {
    snapshot.branch = '(unknown)'
    snapshot.error = err instanceof Error ? err.message : String(err)
  }

  try {
    const status = (await runGit(cwd, ['status', '--porcelain=v1'])).replace(/\r?\n$/, '')
    if (!status) {
      snapshot.status = '(clean)'
    } else {
      const lines = status.split('\n')
      if (lines.length > STATUS_LINE_LIMIT) {
        snapshot.status = lines.slice(0, STATUS_LINE_LIMIT).join('\n')
        snapshot.statusTruncated = true
      } else {
        snapshot.status = lines.join('\n')
      }
    }
  } catch (err) {
    snapshot.status = '(unavailable)'
    snapshot.error = err instanceof Error ? err.message : String(err)
  }

  try {
    const log = (await runGit(cwd, ['log', '-5', '--pretty=format:%h %ad %s', '--date=short'])).trim()
    snapshot.recentCommits = log || '(no commits)'
  } catch (err) {
    snapshot.recentCommits = '(unavailable)'
    snapshot.error = err instanceof Error ? err.message : String(err)
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
  recent: MemoryEntry[]
  decisions: MemoryEntry[]
  notes: MemoryEntry[]
}

function selectMemorySnapshot(entries: MemoryEntry[], identity: ProjectIdentity): MemorySnapshot {
  const active = entries.filter((entry) => !entry.deleted)
  const projectActive = active.filter((entry) => isCurrentProjectMemory(entry, identity))
  const recent = sortByUpdatedAtDesc(projectActive).slice(0, PROJECT_RECENT_LIMIT)
  const decisions = sortByUpdatedAtDesc(projectActive.filter((entry) => entry.category === 'decision')).slice(
    0,
    DECISION_RECENT_LIMIT,
  )
  const notes = sortByUpdatedAtDesc(projectActive.filter((entry) => entry.category === 'note')).slice(
    0,
    NOTE_RECENT_LIMIT,
  )
  return { recent, decisions, notes }
}

// ==================== 报告格式化 ====================

function formatMemoryLine(entry: MemoryEntry): string {
  return `- [${entry.category}] ${entry.key} (id=${entry.id}, updatedAt=${entry.updatedAt}): ${preview(entry.value)}`
}

function formatMemorySection(title: string, entries: MemoryEntry[]): string {
  if (entries.length === 0) return `## ${title}\n(none)`
  return `## ${title}\n${entries.map(formatMemoryLine).join('\n')}`
}

function formatGitSection(snapshot: GitSnapshot): string {
  if (!snapshot.available) {
    return ['## Git', '(not a git repository or git unavailable)'].join('\n')
  }
  const parts: string[] = ['## Git']
  parts.push(`branch: ${snapshot.branch || '(unknown)'}`)
  parts.push('')
  parts.push('status (porcelain):')
  parts.push('```')
  parts.push(snapshot.status || '(unavailable)')
  if (snapshot.statusTruncated) {
    parts.push(`... (truncated to ${STATUS_LINE_LIMIT} lines, run \`git status\` for full output)`)
  }
  parts.push('```')
  parts.push('')
  parts.push('recent commits:')
  parts.push('```')
  parts.push(snapshot.recentCommits || '(unavailable)')
  parts.push('```')
  return parts.join('\n')
}

function buildResumeReport(
  identity: ProjectIdentity,
  git: GitSnapshot,
  memory: MemorySnapshot,
): string {
  const parts: string[] = [
    '# Project Resume Snapshot',
    '',
    `cwd: ${identity.cwd}`,
    `projectId: ${identity.projectId || '(none)'}`,
    `generated: ${new Date().toISOString()}`,
    '',
    formatGitSection(git),
    '',
    formatMemorySection('Recent Project Memories', memory.recent),
    '',
    formatMemorySection('Recent Decisions', memory.decisions),
    '',
    formatMemorySection('Recent Notes', memory.notes),
  ]
  return parts.join('\n')
}

const RESUME_INSTRUCTION = [
  '请基于以上"项目恢复快照"完成两件事：',
  '1. 用 4-6 行中文向主公总结当前项目所处的状态（在哪个分支、有哪些未提交改动、最近做了什么、有哪些近期决策或备忘需要注意）；',
  '2. 给出 2-3 条具体的"下一步建议"，按优先级从高到低排列，每条不超过两句话。',
  '注意：未提交改动属于工作树现状，不是必须立刻处理的待办，建议时不要默认要求提交；如果决策与当前 git 状态有冲突，请明确指出。',
].join('\n')

// ==================== 命令注册 ====================

export default function resumeProject(pi: ExtensionAPI): void {
  pi.registerCommand('resume-project', {
    description:
      'Summarize current project state (cwd / git / recent memories) and ask the model for next-step suggestions',
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd || process.cwd()

      // 必须在 idle 时调用，否则 sendUserMessage 在流式中需要 deliverAs；这里直接拒绝以保持语义清晰
      if (!ctx.isIdle()) {
        ctx.ui.notify('Agent is busy. Run /resume-project after the current response finishes.', 'warning')
        return
      }

      const [identity, git, allMemories] = await Promise.all([
        resolveProjectIdentity(cwd),
        collectGitSnapshot(cwd),
        loadAllMemories(),
      ])
      const memory = selectMemorySnapshot(allMemories, identity)

      const report = buildResumeReport(identity, git, memory)

      // 同步展示一份报告在 UI（方便主公直接看），再把同样内容送给模型让它给建议
      ctx.ui.notify(report, 'info')
      pi.sendUserMessage(`${report}\n\n${RESUME_INSTRUCTION}`)
    },
  })
}
