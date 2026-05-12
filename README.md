# pi-personal-platform

个人 AI 开发平台 - pi 扩展套件（层 2：知识与记忆）

## 定位

`pi-personal-platform` 是基于 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的扩展集合，目标是把 pi 从"通用 coding agent"演化为"主公的个人 AI 开发平台"。

按能力分层规划：

| 层级 | 名称 | 包 | 状态 |
|------|------|----|----|
| 层 1 | 基础设施（模型供应/Provider 切换） | `pi-cc-switch-provider` | 已就绪 |
| 层 2 | **知识与记忆** | **`pi-personal-platform`（本包）** | **建设中** |
| 层 3 | 工作流编排 | `pi-workflows`（计划） | 未开始 |
| 层 4 | 体验定制 | `pi-experience`（计划） | 未开始 |
| 层 5 | 集成与互联 | `pi-integrations`（计划） | 未开始 |

## 已包含的扩展

### profile-injector

把 `profile.md` 自动注入到每次会话的 system prompt 末尾，用于固化跨会话的角色设定、个人偏好、长期规则。

**加载位置（按优先级从低到高）：**

1. `~/.pi/memory/profile.md` - 全局 profile，跨所有项目生效
2. `<项目根>/.pi/memory/profile.md` - 项目级 profile，在全局基础上追加

**TUI 状态行标识：**

- `📜 Profile G+P` 全局 + 项目级同时加载
- `📜 Profile G` 仅全局
- `📜 Profile P` 仅项目级
- （都未配置则不显示）

### memory-tool

当前稳态方案启用 `remember` 工具写入本地记忆，并提供 `/memory` 斜杠命令检索当前项目记忆。检索命令在 pi 本地执行，不走 LLM custom tool schema，用于绕开当前 cc-switch 上游对多工具调用不稳定的问题。

**存储位置：**

```text
~/.pi/memory/store.jsonl
```

**工具清单：**

| 名称 | 类型 | 用途 | 状态 |
|------|------|------|------|
| `remember` | LLM 工具 | 写入或更新一条记忆；同 `category + key + scope + project` 覆盖旧值 | 已启用 |
| `/memory <query>` | 斜杠命令 | 只检索当前项目的 project 记忆，并把结果作为用户消息送回模型 | 已启用 |
| `recall` | LLM 工具 | 原计划按子串检索记忆 | 暂不启用 |
| `list_memory` | LLM 工具 | 原计划列出记忆元数据 | 暂不启用 |

**记忆作用域：**

- `scope="project"`：绑定当前工作目录，适合项目级决策（默认）
- `scope="global"`：跨项目共享，适合主公个人偏好；当前 `/memory` 不自动检索 global 记忆
- 当前阶段 `/memory` 只返回当前工作目录绑定的 project 记忆，避免跨项目串扰

## 安装

### 方式一：本地开发（推荐，开发期使用）

启动 pi 时通过 `-e` 参数加载扩展：

```powershell
pi -e D:\My_work\pi\pi-personal-platform\extensions\profile-injector.ts `
   -e D:\My_work\pi\pi-personal-platform\extensions\memory-tool.ts
```

### 方式二：放入全局扩展目录（自动发现）

```powershell
copy D:\My_work\pi\pi-personal-platform\extensions\profile-injector.ts %USERPROFILE%\.pi\agent\extensions\
copy D:\My_work\pi\pi-personal-platform\extensions\memory-tool.ts %USERPROFILE%\.pi\agent\extensions\
```

放置后 pi 启动会自动发现，且支持 `/reload` 热重载。

### 方式三：作为 pi 包安装（发布后）

```powershell
pi install git:github.com/<owner>/pi-personal-platform
```

## profile.md 示例模板

将以下内容保存为 `~/.pi/memory/profile.md`（注意目录需主公自行创建，扩展不会自动 mkdir）：

```markdown
# Profile

## 角色与礼仪
- 主公（大耳贼）下令，亮（诸葛亮）执行
- 亮自称"亮"，称对方"主公"
- 每次新会话开始时先说："主公，亮已就位，请下令。"

## 全局技术红线
- 严禁猜测：分析必须基于实际代码，不能凭印象给结论
- 不主动 git commit / npm run lint / npm run build / 创建 .md 文档
- 所有文件 UTF-8 无 BOM
- 代码注释统一中文
- 安全 > 正确 > 最小变更 > 可读 > 一致

## 默认技术栈偏好
- 前端：Vue 3 + Element Plus + Vite
- 后端：Spring Boot 3 + MyBatis-Plus + Java 17
- 数据库：达梦 DM8 / MySQL 8
- 浏览器兼容目标：Chrome 78+（禁用 ?. ??）

## 工作目录习惯
- D:\GL_WORK\... 或 D:\A_工作\...
```

项目级 `<项目根>/.pi/memory/profile.md` 可放与该项目专属的偏好（例如该项目自定义命名约定、特定模块的注意事项等），加载时会拼在全局 profile 之后。

## 验证

1. 创建并填写 `~/.pi/memory/profile.md`
2. 启动 pi（任意目录）：
   ```powershell
   pi -e D:\My_work\pi\pi-personal-platform\extensions\profile-injector.ts `
      -e D:\My_work\pi\pi-personal-platform\extensions\memory-tool.ts
   ```
3. 观察 TUI 状态行应出现 `📜 Profile G`
4. 询问亮个人身份相关问题（例如"你的角色是什么"），亮应按 profile.md 内容作答
5. 测试记忆工具：
   - 对亮说：`记住：我喜欢先做最小可用版本，再逐步迭代`
   - 期望：亮调用 `remember` 写入，并告知已保存的 category、key、scope
   - 用 PowerShell 查看落盘：`Get-Content $env:USERPROFILE\.pi\memory\store.jsonl`
   - 在写入该记忆的项目目录中输入 `/memory mvp` 验证本地检索
   - 期望：pi 查出当前项目的匹配记忆，并把结果送回模型回答

## 设计原则

- **不越权**：不自动创建文件 / 目录 / 模板，所有持久化由主公主动操作
- **不缓存**：每次会话启动都重新读 profile.md，修改即时生效
- **不阻塞**：读取失败一律静默跳过，绝不影响 pi 启动
- **不解析**：profile.md 是纯文本，直接注入，不做 frontmatter / 语义分析
- **不替换**：永远追加到 pi 默认 prompt 之后，不破坏原有结构

## 路线图

- [x] `profile-injector` - profile.md 注入器
- [x] `memory-tool` - `remember(category, key, value)` 写入工具
- [x] `memory-tool` - `/memory <query>` 本地检索命令
- [ ] `memory-tool` - 评估是否仍需恢复 `recall(query)` / `list_memory` 工具
- [ ] `decision-log` - 按项目自动记录决策档案
- [ ] `skills-loader` - 跨项目知识技能库装载

## License

MIT
