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

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
  projectId?: string
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

interface ParsedMemoryCommand {
  mode: 'search' | 'list' | 'stats' | 'doctor' | 'global'
  query: string
  limit: number
}

interface MemoryDiagnostics {
  entries: MemoryEntry[]
  storeExists: boolean
  badLines: number
  rawLines: number
  error?: string
}

interface ProjectIdentity {
  cwd: string
  normalizedCwd: string
  projectId?: string
}

const execFileAsync = promisify(execFile)
const GIT_REMOTE_TIMEOUT_MS = 1000
const MEMORY_DIR = join(homedir(), '.pi', 'memory')
const STORE_PATH = join(MEMORY_DIR, 'store.jsonl')
const CATEGORY_VALUES = ['decision', 'preference', 'fact', 'note', 'lesson', 'other']

/** 确保存储目录存在 */
async function ensureMemoryDir(): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true })
}

/** 读取所有记忆，并保留诊断信息 */
async function loadAllWithDiagnostics(): Promise<MemoryDiagnostics> {
  let raw = ''
  try {
    raw = await readFile(STORE_PATH, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], storeExists: false, badLines: 0, rawLines: 0 }
    }
    return { entries: [], storeExists: false, badLines: 0, rawLines: 0, error: (err as Error).message }
  }

  const entries: MemoryEntry[] = []
  let badLines = 0
  let rawLines = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    rawLines += 1
    try {
      entries.push(JSON.parse(trimmed) as MemoryEntry)
    } catch {
      badLines += 1
      // 单行损坏时跳过，避免整个记忆库不可用
    }
  }
  return { entries, storeExists: true, badLines, rawLines }
}

/** 读取所有记忆；文件不存在时返回空数组 */
async function loadAll(): Promise<MemoryEntry[]> {
  const diagnostics = await loadAllWithDiagnostics()
  if (diagnostics.error) throw new Error(diagnostics.error)
  return diagnostics.entries
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
 * Windows 环境下 cwd 可能出现 `D:\\dir`、`D:/dir` 或 Git Bash/MSYS 的 `/d/dir` 形式；
 * 严格按当前项目检索时必须先归一化，避免同一项目因路径写法差异查不到记忆。
 */
function normalizeProjectPath(projectPath: string | undefined): string {
  const normalized = (projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized.replace(/^\/([a-z])\//, '$1:/')
}

/** 归一化稳定项目身份，用于跨电脑/跨路径匹配同一个 Git 仓库 */
function normalizeProjectId(projectId: string | undefined): string | undefined {
  const normalized = (projectId || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
  return normalized || undefined
}

/** 把常见 Git remote URL 归一化为 host/owner/repo */
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
    // 本地路径 remote 没有跨电脑稳定性，暂不作为 projectId
    return undefined
  }
}

/** 解析当前项目身份；Git 不可用或没有 origin 时回退到 cwd 路径 */
async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
  const identity: ProjectIdentity = { cwd, normalizedCwd: normalizeProjectPath(cwd) }
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: GIT_REMOTE_TIMEOUT_MS,
    })
    const projectId = normalizeGitRemoteUrl(stdout)
    if (projectId) identity.projectId = projectId
  } catch {
    // 无 git / 非 git 仓库 / 没有 origin 都正常回退 cwd
  }
  return identity
}

/**
 * 判断记忆是否属于当前项目。
 *
 * 优先用 projectId 匹配同一个 Git 仓库；旧记忆没有 projectId 时回退 cwd 路径匹配。
 * 即使是 global 记忆，也不在 /memory 中自动返回，避免跨项目串扰。
 */
function isVisibleMemory(entry: MemoryEntry, identity: ProjectIdentity): boolean {
  if (entry.scope !== 'project') return false
  const entryProjectId = normalizeProjectId(entry.projectId)
  if (identity.projectId && entryProjectId) return entryProjectId === identity.projectId
  return normalizeProjectPath(entry.project) === identity.normalizedCwd
}

/** 写入或更新记忆 */
async function rememberOp(params: RememberParams, cwd: string): Promise<{ id: string; action: 'created' | 'updated' }> {
  const scope = normalizeScope(params.scope)
  const category = normalizeCategory(params.category)
  const identity = scope === 'project' ? await resolveProjectIdentity(cwd) : undefined
  const project = scope === 'project' ? cwd : undefined
  const projectId = scope === 'project' ? identity?.projectId : undefined
  const now = nowIso()

  return withFileMutationQueue(STORE_PATH, async () => {
    const entries = await loadAll()
    const index = entries.findIndex((entry) => {
      if (entry.deleted) return false
      if (entry.category !== category) return false
      if (entry.key !== params.key) return false
      if (entry.scope !== scope) return false
      if (scope === 'global') return !entry.project
      return identity ? isVisibleMemory(entry, identity) : normalizeProjectPath(entry.project) === normalizeProjectPath(project)
    })

    if (index >= 0) {
      entries[index].value = params.value
      entries[index].updatedAt = now
      if (scope === 'project') {
        entries[index].project = project
        if (projectId) entries[index].projectId = projectId
      }
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
      projectId,
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
async function queryMemory(params: MemoryQueryParams, identity: ProjectIdentity): Promise<MemoryEntry[]> {
  const query = params.query.trim().toLowerCase()
  const limit = Math.min(Math.max(params.limit || 10, 1), 30)
  const entries = await loadAll()

  return entries
    .filter((entry) => !entry.deleted)
    .filter((entry) => isVisibleMemory(entry, identity))
    .filter((entry) => {
      if (!query) return true
      return entry.key.toLowerCase().includes(query) || entry.value.toLowerCase().includes(query)
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

/**
 * 解析 /memory 命令参数。
 *
 * 支持的模式：
 * - `/memory <query>`：按关键词检索当前项目记忆
 * - `/memory list [limit]`：盘点当前项目最近记忆，默认 10 条，最多 30 条
 * - `/memory global [limit]`：盘点全局（scope=global）记忆，默认 10 条，最多 30 条
 * - `/memory stats`：统计当前记忆库规模与分类分布，并附 global 预览列表
 * - `/memory doctor`：诊断 store、cwd、坏行、重复身份等健康状态
 */
function parseMemoryCommand(args: string): ParsedMemoryCommand {
  const text = args.trim()
  const parts = text.split(/\s+/).filter(Boolean)

  if (parts[0] === 'list') {
    const rawLimit = Number(parts[1])
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 10
    return { mode: 'list', query: '', limit: Math.min(Math.floor(limit), 30) }
  }

  if (parts[0] === 'global') {
    const rawLimit = Number(parts[1])
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 10
    return { mode: 'global', query: '', limit: Math.min(Math.floor(limit), 30) }
  }

  if (parts[0] === 'stats') {
    return { mode: 'stats', query: '', limit: 0 }
  }

  if (parts[0] === 'doctor') {
    return { mode: 'doctor', query: '', limit: 0 }
  }

  return { mode: 'search', query: text, limit: 10 }
}

/**
 * 列出 scope=global 的记忆，按 updatedAt 倒序，受 limit 限制。
 * 单独函数；与项目记忆保持隔离，不会受 cwd 影响。
 */
async function listGlobalMemory(limit: number): Promise<MemoryEntry[]> {
  const safeLimit = Math.min(Math.max(limit || 10, 1), 30)
  const entries = await loadAll()
  return entries
    .filter((entry) => !entry.deleted)
    .filter((entry) => entry.scope === 'global')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, safeLimit)
}

/** 格式化 /memory 检索结果，保留 value 全文，方便模型基于记忆回答 */
function formatMemoryForPrompt(entries: MemoryEntry[]): string {
  return entries
    .map((entry, index) => {
      const scopeLabel = entry.scope === 'project' ? `project:${entry.project || '?'}` : 'global'
      const projectIdLine = entry.projectId ? `\nprojectId=${entry.projectId}` : ''
      return `[${index + 1}] id=${entry.id}\ncategory=${entry.category}\nkey=${entry.key}\nscope=${scopeLabel}${projectIdLine}\nupdatedAt=${entry.updatedAt}\nvalue=${entry.value}`
    })
    .join('\n\n')
}

/** 格式化 /memory list 盘点结果，只给摘要，避免一次性注入过多正文 */
function formatMemoryListForPrompt(entries: MemoryEntry[]): string {
  return entries
    .map((entry, index) => {
      const scopeLabel = entry.scope === 'project' ? `project:${entry.project || '?'}` : 'global'
      const projectIdLine = entry.projectId ? `\nprojectId=${entry.projectId}` : ''
      const preview = entry.value.length > 80 ? `${entry.value.slice(0, 80)}...` : entry.value
      return `[${index + 1}] id=${entry.id}\ncategory=${entry.category}\nkey=${entry.key}\nscope=${scopeLabel}${projectIdLine}\nupdatedAt=${entry.updatedAt}\npreview=${preview}`
    })
    .join('\n\n')
}

function countByCategory(entries: MemoryEntry[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    counts[entry.category] = (counts[entry.category] || 0) + 1
  }
  return counts
}

function formatCategoryCounts(counts: Record<string, number>): string {
  const lines = CATEGORY_VALUES.map((category) => `- ${category}: ${counts[category] || 0}`)
  return lines.join('\n')
}

function getIdentityKey(entry: MemoryEntry): string {
  const projectKey = entry.scope === 'project' ? normalizeProjectId(entry.projectId) || normalizeProjectPath(entry.project) : ''
  return `${entry.category}\u0000${entry.key}\u0000${entry.scope}\u0000${projectKey}`
}

function countDuplicateIdentityKeys(entries: MemoryEntry[]): number {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const key = getIdentityKey(entry)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return Array.from(counts.values()).filter((count) => count > 1).length
}

/**
 * 给当前路径可见的旧 project 记忆补 projectId。
 *
 * 只补当前 cwd 路径精确匹配且尚未有 projectId 的旧记忆；不改其他路径，避免误判。
 */
async function backfillCurrentProjectId(identity: ProjectIdentity): Promise<number> {
  if (!identity.projectId) return 0
  return withFileMutationQueue(STORE_PATH, async () => {
    const entries = await loadAll()
    let changed = 0
    for (const entry of entries) {
      if (entry.deleted || entry.scope !== 'project') continue
      if (entry.projectId) continue
      if (normalizeProjectPath(entry.project) !== identity.normalizedCwd) continue
      entry.projectId = identity.projectId
      changed += 1
    }
    if (changed > 0) await saveAll(entries)
    return changed
  })
}

function formatMemoryStats(diagnostics: MemoryDiagnostics, identity: ProjectIdentity): string {
  const activeEntries = diagnostics.entries.filter((entry) => !entry.deleted)
  const deletedEntries = diagnostics.entries.filter((entry) => entry.deleted)
  const visibleProjectEntries = activeEntries.filter((entry) => isVisibleMemory(entry, identity))
  const projectIdMatchedEntries = identity.projectId
    ? activeEntries.filter((entry) => normalizeProjectId(entry.projectId) === identity.projectId).length
    : 0
  const pathMatchedEntries = activeEntries.filter((entry) => normalizeProjectPath(entry.project) === identity.normalizedCwd).length
  const projectMissingProjectId = activeEntries.filter((entry) => entry.scope === 'project' && !entry.projectId).length
  const globalEntries = activeEntries.filter((entry) => entry.scope === 'global')

  // global preview：按 updatedAt 倒序取前 5 条做摘要，方便主公在 stats 里快速扫一眼全局记忆
  const GLOBAL_PREVIEW_LIMIT = 5
  const globalPreview = [...globalEntries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, GLOBAL_PREVIEW_LIMIT)
  const globalPreviewBlock =
    globalPreview.length === 0
      ? 'global preview: (none)'
      : `global preview (top ${globalPreview.length}/${globalEntries.length}):\n${formatMemoryListForPrompt(globalPreview)}`

  return [
    'Memory stats',
    `store: ${STORE_PATH}`,
    `cwd: ${identity.cwd}`,
    `normalized cwd: ${identity.normalizedCwd}`,
    `projectId: ${identity.projectId || '(none)'}`,
    '',
    `store exists: ${diagnostics.storeExists ? 'yes' : 'no'}`,
    `raw json lines: ${diagnostics.rawLines}`,
    `active total: ${activeEntries.length}`,
    `deleted total: ${deletedEntries.length}`,
    `visible current project: ${visibleProjectEntries.length}`,
    `projectId matched entries: ${projectIdMatchedEntries}`,
    `path matched entries: ${pathMatchedEntries}`,
    `project entries missing projectId: ${projectMissingProjectId}`,
    `global: ${globalEntries.length}`,
    '',
    'by category:',
    formatCategoryCounts(countByCategory(activeEntries)),
    '',
    globalPreviewBlock,
  ].join('\n')
}

function formatMemoryDoctor(diagnostics: MemoryDiagnostics, identity: ProjectIdentity): string {
  const activeEntries = diagnostics.entries.filter((entry) => !entry.deleted)
  const deletedEntries = diagnostics.entries.filter((entry) => entry.deleted)
  const visibleProjectEntries = activeEntries.filter((entry) => isVisibleMemory(entry, identity))
  const projectIdMatchedEntries = identity.projectId
    ? activeEntries.filter((entry) => normalizeProjectId(entry.projectId) === identity.projectId).length
    : 0
  const pathMatchedEntries = activeEntries.filter((entry) => normalizeProjectPath(entry.project) === identity.normalizedCwd).length
  const projectMissingProjectId = activeEntries.filter((entry) => entry.scope === 'project' && !entry.projectId).length
  const globalEntries = activeEntries.filter((entry) => entry.scope === 'global')
  const duplicateIdentityKeys = countDuplicateIdentityKeys(activeEntries)
  const longValues = activeEntries.filter((entry) => entry.value.length > 2000).length
  const issues: string[] = []

  if (!diagnostics.storeExists) issues.push('store file does not exist')
  if (diagnostics.error) issues.push(`store read error: ${diagnostics.error}`)
  if (diagnostics.badLines > 0) issues.push(`bad json lines: ${diagnostics.badLines}`)
  if (duplicateIdentityKeys > 0) issues.push(`duplicate identity keys: ${duplicateIdentityKeys}`)
  if (longValues > 0) issues.push(`long values > 2000 chars: ${longValues}`)
  if (projectMissingProjectId > 0) issues.push(`project entries missing projectId: ${projectMissingProjectId}`)

  return [
    'Memory doctor',
    `store path: ${STORE_PATH}`,
    `store exists: ${diagnostics.storeExists ? 'yes' : 'no'}`,
    `bad json lines: ${diagnostics.badLines}`,
    `read error: ${diagnostics.error || 'none'}`,
    '',
    `cwd raw: ${identity.cwd}`,
    `cwd normalized: ${identity.normalizedCwd}`,
    `projectId: ${identity.projectId || '(none)'}`,
    '',
    `active entries: ${activeEntries.length}`,
    `deleted entries: ${deletedEntries.length}`,
    `current project entries: ${visibleProjectEntries.length}`,
    `projectId matched entries: ${projectIdMatchedEntries}`,
    `path matched entries: ${pathMatchedEntries}`,
    `project entries missing projectId: ${projectMissingProjectId}`,
    `global entries: ${globalEntries.length}`,
    `duplicate identity keys: ${duplicateIdentityKeys}`,
    `long values > 2000 chars: ${longValues}`,
    '',
    `status: ${issues.length === 0 ? 'ok' : 'warning'}`,
    issues.length > 0 ? `issues:\n${issues.map((issue) => `- ${issue}`).join('\n')}` : 'issues: none',
  ].join('\n')
}

export default function memoryTool(pi: ExtensionAPI): void {
  // /memory：本地检索命令，不经过 LLM tool schema，且只检索当前项目自己的 project 记忆
  pi.registerCommand('memory', {
    description: 'Search local persistent memories and send the result back into the conversation',
    handler: async (args, ctx) => {
      const command = parseMemoryCommand(args)
      const cwd = ctx.cwd || process.cwd()
      const identity = await resolveProjectIdentity(cwd)
      await backfillCurrentProjectId(identity)

      if (command.mode === 'stats' || command.mode === 'doctor') {
        const diagnostics = await loadAllWithDiagnostics()
        const body = command.mode === 'stats' ? formatMemoryStats(diagnostics, identity) : formatMemoryDoctor(diagnostics, identity)
        ctx.ui.notify(body, diagnostics.error || diagnostics.badLines > 0 ? 'warning' : 'info')
        return
      }

      const hits =
        command.mode === 'global'
          ? await listGlobalMemory(command.limit)
          : await queryMemory({ query: command.query, limit: command.limit }, identity)

      if (hits.length === 0) {
        const emptyMessage =
          command.mode === 'list'
            ? 'No visible memory found'
            : command.mode === 'global'
              ? 'No global memory found'
              : `No memory matched: ${command.query}`
        ctx.ui.notify(emptyMessage, 'info')
        return
      }

      const title =
        command.mode === 'list'
          ? `本地记忆列表（limit=${command.limit}，scope=current-project）`
          : command.mode === 'global'
            ? `全局记忆列表（limit=${command.limit}，scope=global）`
            : `本地记忆检索结果（query=${command.query}）`
      const body =
        command.mode === 'list' || command.mode === 'global'
          ? formatMemoryListForPrompt(hits)
          : formatMemoryForPrompt(hits)
      const instruction =
        command.mode === 'list'
          ? '请基于以上本地记忆列表回答主公，说明当前项目有哪些记忆，并引用相关 key 或 id。'
          : command.mode === 'global'
            ? '请基于以上全局记忆列表回答主公，说明跨项目共享的记忆有哪些，并引用相关 key 或 id。'
            : '请基于以上本地记忆回答主公，并引用相关 key 或 id。'

      if (!ctx.isIdle()) {
        ctx.ui.notify('Agent is busy. Run /memory after the current response finishes.', 'warning')
        return
      }

      // 把检索/盘点结果作为用户消息送回模型，由模型基于当前项目记忆继续回答主公
      pi.sendUserMessage(`${title}\n\n${body}\n\n${instruction}`)
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
