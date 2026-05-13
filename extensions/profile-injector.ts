/**
 * pi-personal-platform / profile-injector
 *
 * 用途：会话启动时把"全局 + 项目级"的 profile.md 追加到 system prompt，
 *       用于固化主公的个人角色设定、长期规则、跨项目偏好。
 *
 * profile.md 加载位置（按优先级从低到高，后者补充/覆盖前者）：
 *   1. ~/.pi/memory/profile.md          全局，跨所有项目生效
 *   2. <cwd>/.pi/memory/profile.md      项目级，在全局之后追加
 *
 * 合并后的内容包裹在 "# Personal Profile" 章节下，追加到 event.systemPrompt 末尾，
 * 位置位于 AGENTS.md 等 contextFiles 之后；不破坏 pi 原有 prompt 结构。
 *
 * TUI 状态行标识（用于调试加载状态）：
 *   📜 Profile G+P   全局 + 项目级 同时加载
 *   📜 Profile G     仅全局
 *   📜 Profile P     仅项目级
 *   （两者都无则不显示状态）
 *
 * 设计原则：
 *   - 不自动创建文件 / 目录，避免越权写入主公的文件系统
 *   - 不做内存缓存，每次会话启动都重新读，保证修改即时生效
 *   - 读取失败一律静默跳过，绝不阻塞会话启动
 *   - 纯文本直接注入，不做语义解析
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 全局 profile 绝对路径：~/.pi/memory/profile.md
const GLOBAL_PROFILE_PATH = join(homedir(), ".pi", "memory", "profile.md");

// 项目级 profile 相对路径：基于当前 cwd 拼接
const PROJECT_PROFILE_RELATIVE = join(".pi", "memory", "profile.md");

// TUI 状态行使用的 key
const STATUS_KEY = "profile";

/**
 * 安全读取文件
 *
 * 读取失败、文件不存在、内容全为空白等情况均返回 undefined，不抛错，
 * 以保证扩展不会阻塞会话启动。
 *
 * @param filePath 文件绝对路径
 * @returns 非空 trimmed 内容；否则 undefined
 */
async function safeRead(filePath: string): Promise<string | undefined> {
	try {
		const content = await readFile(filePath, "utf8");
		const trimmed = content.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		// 文件不存在 / 权限不足 / 编码异常 等情况一律静默忽略
		return undefined;
	}
}

/**
 * 根据加载情况计算 TUI 状态行展示文案
 *
 * @param hasGlobal 全局 profile 是否成功加载
 * @param hasProject 项目级 profile 是否成功加载
 * @returns 状态文案；都未加载时返回 undefined（表示清除状态）
 */
function buildStatusLabel(hasGlobal: boolean, hasProject: boolean): string | undefined {
	// 状态栏避免使用 emoji：部分终端会显示为乱码或重复图标
	if (hasGlobal && hasProject) return "Profile G+P";
	if (hasGlobal) return "Profile G";
	if (hasProject) return "Profile P";
	return undefined;
}

/**
 * 合并全局与项目级 profile 内容
 *
 * 项目级置于全局之后：LLM 心智中越靠后的内容通常更"显眼"，
 * 让项目级特殊规则能覆盖全局通用偏好。
 *
 * @returns 合并后字符串；两者都无则 undefined
 */
function mergeProfile(globalText: string | undefined, projectText: string | undefined): string | undefined {
	if (!globalText && !projectText) return undefined;
	const parts: string[] = [];
	if (globalText) parts.push(globalText);
	if (projectText) parts.push(projectText);
	return parts.join("\n\n---\n\n");
}

/**
 * 把合并后的 profile 内容包装成追加段
 *
 * 统一加 "# Personal Profile" 章节标题，便于模型识别这是用户个人档案，
 * 与 pi 默认 prompt、AGENTS.md 等 context 区分开。
 */
function wrapAsAppendSection(merged: string): string {
	return `\n\n# Personal Profile\n\n${merged}\n`;
}

/**
 * 安全设置/清除 TUI 状态行
 *
 * ctx.ui 的可用性在不同事件 ctx 中未必一致（pi docs 未明确保证），
 * 即便 UI 调用失败也不应影响 prompt 注入这一主功能，因此用 try/catch 静默吞错。
 */
function safeSetStatus(ctx: { ui?: { setStatus?: (key: string, value: string | undefined) => void } }, value: string | undefined): void {
	try {
		ctx.ui?.setStatus?.(STATUS_KEY, value);
	} catch {
		// 状态行属于 UI 表层信息，失败不影响主流程
	}
}

async function loadProfile(cwd: string): Promise<{ globalText: string | undefined; projectText: string | undefined }> {
	const projectProfilePath = join(cwd, PROJECT_PROFILE_RELATIVE);
	const [globalText, projectText] = await Promise.all([
		safeRead(GLOBAL_PROFILE_PATH),
		safeRead(projectProfilePath),
	]);
	return { globalText, projectText };
}

async function refreshProfileStatus(ctx: { cwd?: string; ui?: { setStatus?: (key: string, value: string | undefined) => void } }): Promise<void> {
	const { globalText, projectText } = await loadProfile(ctx.cwd || process.cwd());
	safeSetStatus(ctx, buildStatusLabel(!!globalText, !!projectText));
}

/**
 * 扩展入口
 */
export default function profileInjector(pi: ExtensionAPI): void {
	// session_start 时先刷新状态行；真正的 prompt 注入仍在 before_agent_start 中完成
	pi.on("session_start", async (_event, ctx) => {
		await refreshProfileStatus(ctx);
	});

	// before_agent_start：用户提交输入之后、模型开始推理之前
	// 此时 event.systemPrompt 已经被 pi 构建完成（含 AGENTS.md 等 contextFiles）
	pi.on("before_agent_start", async (event, ctx) => {
		// 从 systemPromptOptions.cwd 拿当前项目根目录
		// 拿不到则 fallback 到 process.cwd()
		const opts = event.systemPromptOptions;
		const cwd = opts && opts.cwd ? opts.cwd : process.cwd();

		// 并行读两个文件，提升启动速度
		const { globalText, projectText } = await loadProfile(cwd);

		const merged = mergeProfile(globalText, projectText);
		const status = buildStatusLabel(!!globalText, !!projectText);

		// 设置状态行（防御性，失败不阻塞主功能）
		safeSetStatus(ctx, status);

		// 若两份 profile 均无内容，则不修改 prompt
		if (!merged) {
			return;
		}

		// 在原 system prompt 末尾追加 profile 段
		// 注意：必须返回 event.systemPrompt + 追加内容，而非替换原 prompt，
		// 否则会丢失 pi 默认 prompt 和先前 handler 的链式修改
		return {
			systemPrompt: event.systemPrompt + wrapAsAppendSection(merged),
		};
	});

	// 会话结束时清除状态行，避免残留显示（同样防御性）
	pi.on("session_shutdown", (_event, ctx) => {
		safeSetStatus(ctx, undefined);
	});
}
