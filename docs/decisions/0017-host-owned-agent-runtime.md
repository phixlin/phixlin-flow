# 宿主 Agent 驱动 Harness

## Context

`$phixlin` 已由当前 Codex 会话作为入口。现有实现又在 `phixlin` CLI 内启动 `codex exec`，形成嵌套 Agent 进程，导致 CLI 与宿主会话的职责重叠，并引入 Windows 可执行文件解析、子进程生命周期和状态悬挂问题。phixlin-flow 的定位是 Harness，应控制流程、状态、证据和门禁，而不是选择或启动底层 Agent CLI。

## Decision

采用宿主 Agent 驱动 Harness 的运行模型：当前宿主会话读取 `$phixlin` Skill，调用 `phixlin` CLI 的控制面命令；Harness 管理 change、Workflow、阶段、Skill 门禁、证据和人工审批；宿主会话按照 `status` 返回的 `next_action` 执行阶段工作，并通过明确的 operation 交接协议提交结构化结果。

phixlin CLI 不启动 Codex、Claude Code 或其他底层 Agent CLI。Runtime 抽象保留为宿主交接边界，不再把 `codex exec` 作为 Harness 内部实现。宿主提交的结果必须绑定 change、operation、state version 和输入摘要；候选摘要、机器检查、验证报告和最终状态仍由 Harness 或宿主可信边界采集与校验。既有 `0008` 的 Codex 子进程适配方案由本决策替代，`0009` 的宿主证据归属继续有效。

## Consequences

状态机、Workflow Profile、planned/contextual Skill、CAS、人工审批、证据和审计包契约继续保留。M3/M4 的运行时实现、失败模型和验收记录需要按宿主交接协议重做；`executing` 必须能区分等待宿主提交、结果未知和已确认失败。当前版本不再承诺由 CLI 自动启动 Codex，也不承诺仅凭 CLI 阻止拥有工作区写权限的宿主在流程外修改文件；阶段门禁只接受经过绑定和校验的 operation 结果。
