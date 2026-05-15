# 安装指南（面向同事）

本文档面向"第一次在自己电脑上装 pi-personal-platform 扩展"的同事。

## 前置环境

| 项 | 要求 | 检查命令 |
|---|---|---|
| pi 主程序 | 已全局安装 | `pi --version` |
| Node.js | ≥ 20 | `node --version` |
| Git | 能访问 GitHub | `git ls-remote https://github.com/Ginkgoooo/pi-personal-platform` |

> 建议先安装 [pi-kiro-go-provider](https://github.com/Ginkgoooo/pi-kiro-go-provider)（Kiro 上游桥接），再装本扩展。两者独立但配合使用效果最佳。

## 一、安装

```bash
pi install git:github.com/Ginkgoooo/pi-personal-platform
```

pi 会自动 clone 仓库到 `~/.pi/agent/git/github.com/Ginkgoooo/pi-personal-platform/`，读取 `package.json` 中的 `pi.extensions` 字段，自动加载三个扩展：

- `profile-injector.ts` — 注入个人 profile
- `memory-tool.ts` — 记忆工具（/memory 命令）
- `auto-memory-injector.ts` — 自动注入相关记忆到上下文

验证：

```bash
pi list
# 应看到 pi-personal-platform 在列表中
```

## 二、准备个人化文件

以下文件是**个人专属**的，不要从别人那里拷贝。

### 2.1 Profile（可选但推荐）

创建 `~/.pi/memory/profile.md`，写入你的个人偏好和工作习惯。示例结构：

```markdown
# Profile

## 角色与称谓
- 你叫我 xxx，我叫你 xxx

## 技术栈偏好
- 前端：Vue 3 + Element Plus
- 后端：Spring Boot 3

## 工作目录
- 项目代码在 D:\xxx\...
```

没有这个文件不会报错，只是状态行不会出现 `Profile G`。

### 2.2 记忆文件

`~/.pi/memory/store.jsonl` 会在使用过程中自动生成，从空开始攒，不需要手动创建。

## 三、第一次启动验证

```bash
cd 你的任意工作目录
pi
```

进入 TUI 后验证：

```text
/memory stats    → 看到记忆库统计信息
/memory doctor   → 看到健康诊断结果
```

两条都正常说明三个扩展加载成功。

状态行含义：

```text
Profile G        # profile.md 已注入
Memory P3+G2    # 当前项目 3 条 + 全局 2 条记忆（无记忆时不显示）
```

## 四、日常使用

每次只需：

```bash
pi
```

pi 启动时自动加载扩展、注入 profile、注入相关记忆，无需额外参数。

## 五、常用命令

| 命令 | 用途 |
|---|---|
| `/memory stats` | 记忆库统计（含 global 预览） |
| `/memory doctor` | 健康诊断 |
| `/memory <query>` | 检索当前项目记忆并送回模型 |
| `/memory list [limit]` | 当前项目最近 N 条（默认 10，上限 30） |
| `/memory global [limit]` | 全局记忆最近 N 条（默认 10，上限 30） |

记忆的写入由 `remember` 工具自动完成，在对话中做出决策或表达偏好时，AI 会主动调用。

## 六、更新

```bash
pi update git:github.com/Ginkgoooo/pi-personal-platform
```

pi TUI 内 `/reload` 热生效，无需退出。

## 七、备份与恢复（可选）

扩展仓库内附带备份脚本，安装后位于：

```text
~/.pi/agent/git/github.com/Ginkgoooo/pi-personal-platform/scripts/
```

```powershell
# 导出
powershell -ExecutionPolicy Bypass -File ~/.pi/agent/git/github.com/Ginkgoooo/pi-personal-platform/scripts/export-memory.ps1 -OutputDir D:\Backup

# 导入（覆盖式，会先备份当前数据到 ~/.pi/memory-backups/）
powershell -ExecutionPolicy Bypass -File ~/.pi/agent/git/github.com/Ginkgoooo/pi-personal-platform/scripts/import-memory.ps1 -ZipPath D:\Backup\pi-memory-XXX.zip
```

## 八、故障排查

| 症状 | 处理 |
|---|---|
| `pi list` 看不到扩展 | 重新 `pi install git:github.com/Ginkgoooo/pi-personal-platform` |
| 状态行没有 `Profile G` | `~/.pi/memory/profile.md` 不存在，创建即可 |
| `/memory stats` 报错 | 扩展未加载；`pi list` 确认安装，重启 pi |
| `/memory doctor` 报坏行 | store.jsonl 有损坏行，doctor 会提示具体行号，手动删除即可 |

## 九、已知限制

- project 记忆按 **cwd 路径**绑定，同一仓库换电脑 / 换盘符路径不同会导致 project 记忆匹配不到
- global 记忆不受 cwd 影响，跨项目共享

## 十、卸载

```bash
pi remove git:github.com/Ginkgoooo/pi-personal-platform

# 如需彻底清理记忆数据（可选）
# PowerShell:
Remove-Item -Recurse -Force $env:USERPROFILE\.pi\memory
```
