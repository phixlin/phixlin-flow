# phixlin-flow
phixlin-flow 是面向编码 Agent 的、可适配多平台的确定性交付 Harness。它将需求澄清、规格制定、代码实现、机器验证、人工确认和知识归档组织为可审计、可恢复的工作流。

M2 Harness 编排与交接已通过 Fake Runtime 和真实文件证据验收，覆盖 Skill 顺序交接、恢复、候选审查、全量验证与修复预算。真实 Codex、工作区采集和命令执行属于 M3。状态、CAS 和 CLI 契约见 [`docs/contracts/`](docs/contracts/)；里程碑进度和已知平台阻塞见 [`docs/implementation-roadmap.md`](docs/implementation-roadmap.md)。

## 命令

| 命令 | 用途 |
|---|---|
| pnpm test | 单元测试 |
| pnpm typecheck | 类型检查 |
| pnpm lint | 静态检查 |
| pnpm spike:cas | 重跑 Linux advisory lock 与原子替换 spike |
| pnpm test:smoke | 真实入口冒烟测试 |
| pnpm check:all | 全量本地门禁 |
