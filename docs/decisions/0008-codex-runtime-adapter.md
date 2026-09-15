# 背景

M2 的 Stage Runner 只能驱动 Fake Runtime。M3 需要把阶段调用映射到 Codex CLI，同时保留可审计事件并处理进程失败。

# 决策

新增 `CodexRuntimeAdapter`，使用 `codex exec --ephemeral --json` 执行单次调用。适配器接收显式 sandbox、工作目录、超时和可注入的 spawn；原始 stdout 作为内容寻址工件保存。退出码非零、超时或缺少结构化 `RuntimeResult` 均返回 blocked，不自动重试或伪造通过结果。

# 后果

真实 Codex 调用可以接入既有 Stage Runner，事件流可恢复核对；CLI 输出必须包含 `kind`（或包装在 `result` 中）的结构化结果。适配器不负责状态推进、审批或工作区快照，这些仍由控制器处理。
