# phixlin-flow
phixlin-flow 是面向编码 Agent 的、可适配多平台的确定性交付 Harness。它将需求澄清、规格制定、代码实现、机器验证、人工确认和知识归档组织为可审计、可恢复的工作流。

M3 Codex 真实闭环、M4 恢复增强和 M5 可运维 MVP 已完成本地验收：覆盖完整交付闭环、暂停恢复、故障边界、可操作状态查询，以及带哈希的离线审计包。真实运行证据位于 [`docs/evidence/m3/`](docs/evidence/m3/)；本地示例见 [`examples/`](examples/)；状态、CAS 和 CLI 契约见 [`docs/contracts/`](docs/contracts/)；准确进度和宿主限制见 [`docs/implementation-roadmap.md`](docs/implementation-roadmap.md)。

构建后可通过 `dist/src/cli.js` 使用入口：

```bash
pnpm build
node dist/src/cli.js start <change-id> --workflow <name> --brief <path>
node dist/src/cli.js status <change-id>
node dist/src/cli.js export-evidence <change-id> --output <bundle-path>
node dist/src/cli.js verify-evidence <bundle-path>
```

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
