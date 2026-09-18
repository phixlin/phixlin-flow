# M3 真实运行证据

本目录由 `codex-cli 0.150.1` 在调用方明确授权的 `danger-full-access` 模式下生成。

- `real-bugfix-full/`：真实 bugfix 的完整闭环，最终 `state_version: 30`、`phase: completed`、`status: done`。
- `real-skilled-shape/`：两个 planned Shape Skill 的顺序执行记录，二者各执行一次并保留 raw output。
- `real-repair/`：宿主检查首轮退出 9，Harness 保留失败并回 Build，后续全量验证通过，最终 `state_version: 34`、`phase: completed`、`status: done`。

每个目录包含 `flow-state.yaml`、`workflow.json`、`manifest.json` 和递归收集的内容寻址工件。导出前后的凭据模式扫描未发现 Authorization、Bearer、API key 或 `sk-` 值。事件中的 Codex thread ID 和上游 request ID 保留用于故障关联，不属于认证凭据。
