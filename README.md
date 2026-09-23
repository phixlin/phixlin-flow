# phixlin-flow
phixlin-flow 是面向编码 Agent 的、可适配多平台的确定性交付 Harness。它将需求澄清、规格制定、代码实现、机器验证、人工确认和知识归档组织为可审计、可恢复的工作流。

M3 Codex 真实闭环、M4 恢复增强和 M5 可运维 MVP 已完成本地验收：覆盖完整交付闭环、暂停恢复、故障边界、可操作状态查询，以及带哈希的离线审计包。真实运行证据位于 [`docs/evidence/m3/`](docs/evidence/m3/)；本地示例见 [`examples/`](examples/)；状态、CAS 和 CLI 契约见 [`docs/contracts/`](docs/contracts/)；准确进度和宿主限制见 [`docs/implementation-roadmap.md`](docs/implementation-roadmap.md)。

安装并构建 CLI，在目标 Git 项目初始化后启动 Codex：

```bash
# 在本工程目录
pnpm install
pnpm build
pnpm add --global .
```

安装后先确认终端能找到 `phixlin`（PowerShell：`Get-Command phixlin`；bash：`command -v phixlin`）。若全局目录未加入 `PATH`，先运行 `pnpm setup` 并重新打开终端，返回本工程目录重新执行 `pnpm add --global .`。

```bash
# 在目标项目目录
phixlin init # 当前目录/.phixlin；--scope user 为用户主目录/.phixlin
codex
```

已启动的 Codex 会话需重启，以继承更新后的 `PATH`。

在 Codex 对话中输入 `$phixlin <需求文本或文档路径>`。初始化会安装 Codex 入口 Skill；Workflow 引用的业务 Skill 由 Codex 管理，需预先安装。默认 Workflow 使用 `requirements-review`。初始化作用域、示例和确认流程见 [examples/README.md](examples/README.md)。

## 命令

| 命令 | 用途 |
|---|---|
| pnpm test | 单元测试 |
| pnpm typecheck | 类型检查 |
| pnpm lint | 静态检查 |
| pnpm spike:cas | 重跑 Linux advisory lock 与原子替换 spike |
| pnpm test:smoke | 真实入口冒烟测试 |
| pnpm check:all | 全量本地门禁 |

Windows 开发环境支持 Node.js 22、pnpm install 和 pnpm check:all，不需要 Python 或 Visual Studio C++ Build Tools。Store 使用跨平台文件锁；异常退出后的锁会在 stale 窗口后恢复。依赖 shell 可执行文件的 Codex Runtime fixture 暂不在 Windows 上运行。
