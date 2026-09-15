# Context

M3 和 M4 已能运行、暂停和恢复完整流程，但操作者仍需自行解释原始状态才能判断是否需要介入，原有审计包也只记录工件引用，无法离线发现状态、Workflow 或额外文件被修改。M5 需要在不依赖 change 存储和运行时的条件下完成诊断与审计。

# Decision

`status` 输出阶段 visit、修复 iteration、内层 lifecycle 与位置、planned Skill 完成度、最近五条状态转换、人工介入标记，以及绑定当前 `state_version` 和 `next_action` 的建议命令。可重试 blocker 同时携带 `recovery_command`。

审计包的 `manifest.json` 列出 `flow-state.yaml`、`workflow.json` 和递归发现的全部工件，记录路径、字节数、SHA-256 与用途分类。`verify-evidence` 在离线目录中验证完整文件集合、每个文件摘要、状态契约、change 标识、Workflow 快照和状态直接引用。为避免自引用哈希，manifest 不列出自身；校验器只允许 manifest 和清单列出的文件，因而额外文件也会失败。

# Consequences

操作者可以只读一次 `status` 判断是否需要人工动作并复制当前有效命令。审计包可独立传递和验证，删除、篡改、增加文件都会明确失败。manifest 本身没有外部签名，攻击者若能同时重写整个审计包仍可重新计算清单；真实性签名不属于 M5 范围。
