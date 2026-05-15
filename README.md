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

- `Profile G+P` 全局 + 项目级同时加载
- `Profile G` 仅全局
- `Profile P` 仅项目级
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
| `remember` | LLM 工具 | 写入或更新一条记忆；同 `category + key + scope + projectId/cwd` 覆盖旧值 | 已启用 |
| `/memory <query>` | 斜杠命令 | 只检索当前项目的 project 记忆，并把结果作为用户消息送回模型 | 已启用 |
| `/memory list [category] [limit]` | 斜杠命令 | 盘点当前项目最近记忆；可按分类过滤；默认 10 条，最多 30 条，只返回摘要 | 已启用 |
| `/memory show <id>` | 斜杠命令 | 显示单条可管理记忆全文，包括 deleted 状态 | 已启用 |
| `/memory delete <id>` | 斜杠命令 | 软删除单条可管理记忆，不物理删除 | 已启用 |
| `/memory restore <id>` | 斜杠命令 | 恢复单条已软删除记忆 | 已启用 |
| `/decision <content>` | 斜杠命令 | 半自动记录当前项目决策，写入 `category=decision` 的 project 记忆 | 已启用 |
| `/decision list [limit]` | 斜杠命令 | 查看当前项目最近决策 | 已启用 |
| `/decision show <id>` | 斜杠命令 | 查看单条项目决策全文 | 已启用 |
| `/memory stats` | 斜杠命令 | 统计记忆库规模、当前项目可见数量、projectId/path 匹配数量、global 数量和分类分布 | 已启用 |
| `/memory doctor` | 斜杠命令 | 诊断 store 文件、坏行、projectId/cwd 匹配、重复身份 key、过长 value 等健康状态 | 已启用 |
| `recall` | LLM 工具 | 原计划按子串检索记忆 | 暂不启用 |
| `list_memory` | LLM 工具 | 原计划列出记忆元数据；当前由 `/memory list` 替代 | 暂不启用 |

**记忆作用域：**

- `scope="project"`：绑定当前项目，适合项目级决策（默认）
- `scope="global"`：跨项目共享，适合主公个人偏好；当前 `/memory` 不自动检索 global 记忆
- 当前项目优先用 Git `origin` remote 归一化出的 `projectId` 匹配（例如 `github.com/owner/repo`），支持不同电脑、不同路径共享同一仓库记忆
- 无 Git remote、Git 不可用或旧记忆没有 `projectId` 时，自动回退到 cwd 路径匹配
- `/memory` 只返回当前项目的 project 记忆，避免跨项目串扰

### auto-memory-injector

会话中每次 agent 开始推理前，自动读取 `~/.pi/memory/store.jsonl`，把少量本地记忆摘要追加到 system prompt，减少手动 `/memory list` 的次数。

**注入规则：**

- 当前项目 `scope="project"` 记忆：最多 5 条，优先按 `projectId` 匹配，按 `updatedAt` 倒序
- 全局 `scope="global"` 记忆：最多 3 条，按 `updatedAt` 倒序
- 只注入摘要 preview，不注入完整正文；需要全文时仍使用 `/memory <query>`
- 忽略 `deleted=true` 记忆
- 读取失败、单行 JSON 损坏、没有可见记忆时均静默跳过

**TUI 状态行标识：**

- `Memory P5+G3` 当前项目 5 条 + 全局 3 条
- `Memory P5` 仅当前项目记忆
- `Memory G3` 仅全局记忆
- （无可注入记忆则不显示）

## 安装

### 方式一：作为 pi 包安装（推荐，日常使用）

公开 GitHub 仓库可直接安装为 pi package：

```powershell
pi install git:github.com/<owner>/pi-personal-platform
```

以后日常启动只需进入项目目录执行：

```powershell
pi
```

更新扩展：

```powershell
pi update --extensions
```

### 方式二：本地开发

开发调试时可通过 `-e` 参数临时加载扩展：

```powershell
pi -e D:\My_work\pi\pi-personal-platform\extensions\profile-injector.ts `
   -e D:\My_work\pi\pi-personal-platform\extensions\memory-tool.ts `
   -e D:\My_work\pi\pi-personal-platform\extensions\auto-memory-injector.ts
```

### 方式三：放入全局扩展目录（自动发现）

```powershell
copy D:\My_work\pi\pi-personal-platform\extensions\profile-injector.ts %USERPROFILE%\.pi\agent\extensions\
copy D:\My_work\pi\pi-personal-platform\extensions\memory-tool.ts %USERPROFILE%\.pi\agent\extensions\
copy D:\My_work\pi\pi-personal-platform\extensions\auto-memory-injector.ts %USERPROFILE%\.pi\agent\extensions\
```

放置后 pi 启动会自动发现，且支持 `/reload` 热重载。

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
2. 确认已通过 `pi install git:github.com/<owner>/pi-personal-platform` 安装；若在本地开发调试，也可使用上文 `-e` 参数启动
3. 进入目标项目目录并启动 pi：
   ```powershell
   pi
   ```
4. 观察 TUI 状态行应出现 `Profile G`
5. 观察有可见记忆时 TUI 状态行应出现 `Memory ...`
6. 询问亮个人身份相关问题（例如"你的角色是什么"），亮应按 profile.md 内容作答
7. 测试记忆工具：
   - 对亮说：`记住：我喜欢先做最小可用版本，再逐步迭代`
   - 期望：亮调用 `remember` 写入，并告知已保存的 category、key、scope
   - 用 PowerShell 查看落盘：`Get-Content $env:USERPROFILE\.pi\memory\store.jsonl`
   - 在写入该记忆的项目目录中输入 `/memory mvp` 验证本地检索
   - 期望：pi 查出当前项目的匹配记忆，并把结果送回模型回答
   - 输入 `/memory list` 验证当前项目记忆盘点
   - 期望：pi 返回当前项目最近 10 条记忆摘要；也可用 `/memory list 30` 指定条数，上限 30
   - 输入 `/memory list preference` 或 `/memory list decision 20` 验证按分类过滤
   - 从列表复制一个 id，输入 `/memory show <id>` 查看单条完整记忆
   - 输入 `/memory delete <id>` 验证软删除，再输入 `/memory restore <id>` 恢复
   - 输入 `/decision 当前阶段先手动验证 projectId，再继续做 workflow-lite` 验证半自动决策记录
   - 输入 `/decision list` 或 `/memory list decision` 验证决策可查询
   - 输入 `/memory stats` 查看记忆库统计
   - 输入 `/memory doctor` 诊断记忆系统健康状态

## 手动同步记忆

当前推荐先用脚本手动打包/恢复本机记忆，采用“以导入包为准”的覆盖式同步。适合公司电脑与家里电脑之间低频同步。

**导出本机记忆：**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\export-memory.ps1 -OutputDir D:\Backup
```

会生成类似：

```text
D:\Backup\pi-memory-COMPUTER-20260513-153000.zip
```

**导入另一台电脑的记忆包：**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\import-memory.ps1 -ZipPath D:\Backup\pi-memory-COMPUTER-20260513-153000.zip
```

导入前会自动把本机现有 `profile.md` 和 `store.jsonl` 备份到：

```text
~/.pi/memory-backups/
```

注意：导入是覆盖式同步，不做双向合并。哪台电脑记忆最新，就从哪台导出并覆盖另一台。

## 设计原则

- **不越权**：扩展运行时不自动创建 profile 模板；持久化写入和同步脚本只在主公明确触发时执行
- **不缓存**：profile 与 memory 每次会话/推理前重新读取，修改可尽快生效
- **不阻塞**：读取失败一律静默跳过，绝不影响 pi 启动
- **不解析 profile**：profile.md 是纯文本，直接注入，不做 frontmatter / 语义分析
- **不替换 prompt**：永远追加到 pi 默认 prompt 之后，不破坏原有结构
- **稳定优先**：检索和自动注入优先走本地逻辑，避免恢复不稳定的多 LLM custom tool schema

## 路线图

- [x] `profile-injector` - profile.md 注入器
- [x] `memory-tool` - `remember(category, key, value)` 写入工具
- [x] `memory-tool` - `/memory <query>` 本地检索命令
- [x] `memory-tool` - `/memory list [category] [limit]` 本地盘点/分类过滤命令
- [x] `memory-tool` - `/memory show/delete/restore <id>` 本地查看与软删除/恢复命令
- [x] `memory-tool` - `/memory stats` 与 `/memory doctor` 本地统计/诊断命令
- [x] `auto-memory-injector` - 会话推理前自动注入少量本地记忆摘要
- [x] `memory-backup` - 手动导出/导入本地记忆 zip
- [x] `projectId` - 用 Git remote 等稳定项目身份替代单纯 cwd 路径匹配，支持多电脑路径不同场景
- [x] `decision-log` - 按项目半自动记录决策档案
- [ ] `skills-loader` - 跨项目知识技能库装载
- [ ] `memory-tool` - 评估是否仍需恢复 `recall(query)` 工具

## License

MIT
