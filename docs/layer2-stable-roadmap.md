# 个人 AI 开发平台层 2 稳当路线规划

本文档用于规划 `pi-personal-platform` 的层 2「知识与记忆」建设路线。目标是在不过度设计的前提下，逐步把 pi 从通用 coding agent 演进为可跨会话、跨项目、跨电脑延续上下文的个人 AI 开发平台。

## 总目标

把 `pi-personal-platform` 建设成稳定、可诊断、可迁移、可治理的个人记忆与知识系统，优先解决三个真实痛点：

1. 每次新会话不用重新交代背景；
2. 公司电脑和家里电脑能共享项目记忆；
3. 重要项目决策不会丢。

## 当前基线

当前已经完成：

- [x] `profile-injector`：全局/项目级 profile 注入
- [x] `memory-tool`：`remember` 写入工具
- [x] `/memory <query>`：当前项目记忆检索
- [x] `/memory list [limit]`：当前项目记忆盘点
- [x] `auto-memory-injector`：推理前自动注入少量记忆摘要
- [x] GitHub pi package 安装方式
- [x] 手动记忆导出/导入脚本
- [x] `/memory stats`：记忆库统计
- [x] `/memory doctor`：记忆系统健康诊断

状态栏正常示例：

```text
Memory P5+G1 Profile G
```

含义：

- `Memory P5`：当前项目最多 5 条记忆摘要已自动注入；
- `Memory G1`：全局 1 条记忆摘要已自动注入；
- `Profile G`：全局 profile 已加载。

## 建设原则

- **稳定优先**：优先本地文件、本地命令、本地 prompt 注入，避免过早依赖复杂服务。
- **小步快跑**：每一阶段都要能独立交付、独立验证。
- **不急着 RAG**：当前记忆规模较小时，JSONL + 关键词检索 + 自动摘要注入足够。
- **不急着自动同步**：先用手动 zip 覆盖同步，等真实痛点出现后再做自动同步。
- **不急着全自动记忆**：重要决策先半自动确认，避免污染记忆库。
- **不走不稳定工具链**：检索和诊断优先用 slash command，不恢复不稳定的多 LLM custom tool schema。

## 阶段 0：收尾与稳定

### 目标

把当前已经完成的能力提交、验证、固化，不继续堆功能。

### 任务

- [ ] 提交 `/memory stats` 与 `/memory doctor`
- [ ] 提交 README 最新规划与用法更新
- [ ] 两台电脑分别验证 GitHub package 安装/更新
- [ ] 验证手动记忆导出/导入脚本
- [ ] 使用观察 2-3 天

### 观察点

- `Memory P...+G... Profile G` 是否稳定出现；
- `/memory stats` 是否准确；
- `/memory doctor` 是否能排查问题；
- 手动记忆打包是否顺手；
- 两台电脑是否存在项目路径不同问题。

### 暂不做

- 自动同步；
- 向量库；
- 自动决策记录；
- RAG；
- IDE 插件。

### 完成标准

- 工作区干净；
- 两台电脑都可安装/更新 GitHub 包；
- 手动记忆导出/导入可用；
- `/memory stats` 与 `/memory doctor` 输出正常。

## 阶段 1：多电脑项目身份 `projectId`

### 背景

当前 project 记忆按 cwd 绑定，例如：

```text
D:\My_work\pi\pi-personal-platform
```

如果家里电脑路径不同，例如：

```text
E:\Code\pi-personal-platform
```

则当前项目记忆可能匹配不到。

### 目标

同一个 Git 仓库，不管在哪台电脑、哪个路径，都能匹配同一批 project 记忆。

### 设计

优先读取 Git remote：

```bash
git remote get-url origin
```

将以下形式归一化：

```text
https://github.com/owner/repo.git
git@github.com:owner/repo.git
```

统一为：

```text
github.com/owner/repo
```

记忆结构新增可选字段：

```json
{
  "scope": "project",
  "project": "D:\\My_work\\pi\\pi-personal-platform",
  "projectId": "github.com/owner/pi-personal-platform"
}
```

匹配规则：

1. 如果当前 cwd 可识别 `projectId`，优先用 `projectId` 匹配；
2. 如果旧记忆没有 `projectId`，回退到 cwd 路径匹配；
3. `global` 记忆仍按 global 处理。

### 需要改动

- `extensions/memory-tool.ts`
  - `MemoryEntry` 增加 `projectId?: string`
  - `rememberOp`
  - `isVisibleMemory`
  - `/memory stats`
  - `/memory doctor`
- `extensions/auto-memory-injector.ts`
  - 当前项目记忆筛选逻辑

### 诊断增强

`/memory doctor` 增加：

```text
projectId: github.com/owner/pi-personal-platform
projectId matched entries: 10
path matched entries: 10
```

### 风险

- 调用 git 命令可能失败；
- 无 Git 仓库时必须回退 cwd；
- 无 remote 项目也要正常工作；
- 旧记忆不能失效。

### 完成标准

- 同一仓库不同路径仍显示 `Memory P...`；
- 旧路径记忆仍可见；
- `/memory doctor` 能显示 `projectId` 与匹配数量。

## 阶段 2：记忆治理与安全维护

### 目标

让记忆库可维护、可清理、可备份、可诊断。

### 功能规划

#### `/memory show <id>`

显示单条完整记忆。

```text
/memory show mem_xxx
```

#### `/memory delete <id>`

软删除记忆，只设置：

```json
"deleted": true
```

不物理删除。

#### `/memory restore <id>`

恢复软删除记忆。

```text
/memory restore mem_xxx
```

#### `/memory list <category>`

按分类过滤当前项目记忆。

```text
/memory list decision
/memory list note
/memory list preference
```

#### 记忆更新提醒

`remember` 写入成功后提示：

```text
Memory updated. Remember to export memory if you switch computers.
```

暂不自动同步。

### 完成标准

- 错误记忆可软删除；
- 误删可恢复；
- 单条记忆可查看；
- 分类可过滤；
- 记忆更新后有同步提醒。

## 阶段 3：决策沉淀 `decision-log`

### 目标

让重要项目决策不再完全依赖“记住：xxx”。第一版必须半自动，不做全自动。

### 第一版命令

```text
/decision <内容>
```

示例：

```text
/decision 当前阶段不做自动 memory-sync，只保留手动 zip 覆盖同步
```

写入记忆：

```json
{
  "category": "decision",
  "scope": "project",
  "key": "decision-20260513-xxxx",
  "value": "当前阶段不做自动 memory-sync，只保留手动 zip 覆盖同步"
}
```

### 辅助命令

```text
/decision list
/decision show <id>
```

也可以复用：

```text
/memory list decision
/memory show <id>
```

### 为什么不全自动

全自动决策记录容易导致：

- 普通讨论被误记；
- 错误方案被沉淀；
- 记忆污染；
- 隐私风险；
- 后续清理成本高。

### 可选增强

当模型发现明显决策时，只提示：

```text
这像是一条项目决策，主公若要记录，可输入：/decision ...
```

不要自动写。

### 完成标准

- 主公能一条命令记录项目决策；
- 决策能被 `/memory list decision` 查到；
- `auto-memory-injector` 能自动注入最近决策。

## 阶段 4：项目恢复与交接 `workflow-lite`

### 目标

把每日开工和公司/家里切换时的固定动作产品化。

### `/resume-project`

每天开工时生成项目恢复摘要。

输出内容：

- 当前目录；
- Git branch；
- Git status；
- 最近 5 条 commit；
- Memory P/G 状态；
- 最近 decision/note；
- 建议下一步。

### `/handoff`

下班或切换电脑前生成交接摘要。

输出内容：

- 今日完成；
- 未提交修改；
- 最近决策；
- 下一步建议；
- 记忆导出提醒。

### 完成标准

- 每天开工不用手动问“查记忆和 git 状态”；
- 两台电脑切换时能快速交接；
- 与手动记忆导出脚本形成配合。

## 阶段 5：skills 知识技能库

### 目标

把长期稳定的技术知识从 memory 中分离出来。

memory 更适合：

- 项目决策；
- 个人偏好；
- 近期上下文；
- 经验教训。

skills 更适合：

- Vue 3 规范；
- Spring Boot 规范；
- 达梦数据库注意事项；
- Chrome 78 兼容规则；
- 代码审查清单。

### 执行策略

先调研 pi 原生 skills，不重复造轮子。

推荐先阅读：

```text
docs/skills.md
```

再决定：

- 直接使用 pi 原生 skills；
- 做 `skills-loader`；
- 做 `skills-organizer`。

### 推荐目录

```text
~/.pi/skills/
  vue3/SKILL.md
  spring-boot/SKILL.md
  dm8/SKILL.md
  chrome78/SKILL.md
```

### 第一版目标

先支持手动使用：

```text
/skill:vue3
/skill:spring-boot
```

后续再考虑根据项目自动启用。

### 完成标准

- 常用技术规范从 profile/memory 中拆出来；
- 项目可按需加载技能；
- 不显著膨胀默认 prompt。

## 阶段 6：轻量 RAG / 文档知识库

### 启动条件

不要现在开始。等满足任一条件再做：

- memory 超过 500 条；
- 项目文档超过 100 个；
- 关键词检索明显不够用；
- 需要检索 README/API/设计文档等项目资料。

### 技术原则

第一版不要上重型方案：

- 不上 Graph RAG；
- 不上 Milvus；
- 不上 Pinecone；
- 不做复杂知识图谱。

优先考虑轻量方案：

- SQLite FTS；
- LanceDB；
- Chroma。

### 文档范围

先只索引：

```text
README.md
docs/**/*.md
AGENTS.md
*.sql
接口文档
```

不要一开始扫全代码库。

### 可能命令

```text
/knowledge index
/knowledge search <query>
/knowledge stats
```

### 完成标准

- 能检索项目文档；
- 能引用来源；
- 不影响 pi 启动速度；
- 不破坏现有 memory 系统。

## 暂不建议近期做的功能

以下功能长期有价值，但不是当前优先级：

- 自动 memory-sync；
- 向量数据库；
- Graph RAG；
- IDE 插件；
- GitHub PR 自动审查；
- Jira 集成；
- subagent 多代理；
- 统一调度面板。

原因：

- 当前记忆量还小；
- 手动 zip 同步已够用；
- 过早自动化会引入冲突和安全风险；
- 层 2 应先稳住记忆与知识底座。

## 近期执行顺序

### 最近 1 天

1. 提交 `/memory stats` 与 `/memory doctor`；
2. 提交 README 更新；
3. 两台电脑更新 GitHub 包验证。

### 最近 1 周

1. 做 `projectId`；
2. 更新 `/memory doctor` 显示 `projectId`；
3. 验证两台电脑不同路径仍能识别项目记忆。

### 最近 2 周

1. 做 `/memory show/delete/restore`；
2. 做 `/memory list <category>`；
3. 做 `/decision`。

### 最近 1 个月

1. 做 `/resume-project`；
2. 做 `/handoff`；
3. 调研并整理 skills。

### 1 个月以后

根据实际记忆规模，再决定是否做轻量 RAG。

## README 路线图建议

后续可将 README 路线图整理为：

```markdown
## 路线图

### M1 本地记忆 MVP
- [x] profile-injector
- [x] remember
- [x] /memory <query>
- [x] /memory list [limit]
- [x] auto-memory-injector
- [x] memory-backup
- [x] /memory stats
- [x] /memory doctor

### M2 多设备稳定化
- [ ] projectId
- [ ] /memory show <id>
- [ ] /memory delete <id>
- [ ] /memory restore <id>
- [ ] /memory list <category>

### M3 决策沉淀
- [ ] /decision <content>
- [ ] /decision list
- [ ] decision auto-suggest only

### M4 项目恢复与交接
- [ ] /resume-project
- [ ] /handoff

### M5 技能库
- [ ] skills 调研
- [ ] skills-loader / skills-organizer

### M6 轻量知识库
- [ ] /knowledge index
- [ ] /knowledge search
```

## 最终判断

最稳当路线不是马上上 RAG，而是先把现有 JSONL 记忆系统做成可靠、可诊断、可迁移、可治理的个人记忆底座。

当前阶段最重要的判断：

```text
能不用数据库就不用数据库；
能不用自动同步就不用自动同步；
能本地命令解决就不走 LLM tool；
能半自动确认就不全自动。
```

下一步最推荐：

```text
projectId
```

因为主公已经明确存在公司/家里两台电脑，这是比 RAG 更现实、更基础的刚需。
