# phixlin-flow
phixlin-flow 是面向编码 Agent 的、可适配多平台的确定性交付 Harness。它将需求澄清、规格制定、代码实现、机器验证、人工确认和知识归档组织为可审计、可恢复的工作流。

M3 Codex 真实闭环与 M4 恢复增强已完成本地验收：覆盖 planned Skill 顺序执行、真实代码修改、宿主检查、独立 Review/Verify、人工门禁、修复回路、暂停恢复、工件漂移拒绝、故障预算和日志脱敏。真实运行证据位于 [`docs/evidence/m3/`](docs/evidence/m3/)；状态、CAS 和 CLI 契约见 [`docs/contracts/`](docs/contracts/)；准确进度和宿主限制见 [`docs/implementation-roadmap.md`](docs/implementation-roadmap.md)。

构建后可通过 `dist/src/cli.js` 使用入口：

```bash
pnpm build
node dist/src/cli.js start <change-id> --workflow <name> --brief <path>
node dist/src/cli.js status <change-id>
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
