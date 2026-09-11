# 0003 使用确定性执行记录完成 Skill 间交接

## Context

项目 Workflow Profile 可以编排自建 Skill 和开源 Skill，但第三方 Skill 的输出格式不同。曾考虑在每个业务 Skill 后调用一个自建 `handoff-normalizer` 系统 Skill，将自由输出转换为统一语义结构。该方案会为每次 Skill 增加额外模型调用、成本和故障点，并让 planned Skill 的完成依赖另一个不确定输出。通用 Schema 还可能遗漏或改写第三方 Skill 的原始结论。

## Decision

MVP 不实现通用 `handoff-normalizer` Skill。Harness 使用普通代码持久化 `SkillExecutionRecord`，记录 change/阶段/revision 绑定、调用模式、原始输出、工件引用和 workspace 前后摘要。

后续 Skill 的输入按确定性规则组装：直接前驱传完整原始输出，更早的执行传记录和工件引用，并附当前 brief/spec、阶段目标及 workspace diff。Harness 不解释第三方 Skill 的自由文本。业务语义由阶段 Agent 在 Shape、Build、Verify 边界形成 Shape Handoff、Builder Handoff 和 Verification Result。

contextual Skill 使用相同执行记录，并区分 runtime 提供的 host-observed 事件与模型自报的 model-reported 信息。只有 planned Skill 的宿主执行记录参与阶段完成门禁。

## Consequences

Skill 间交接不增加额外模型调用，第三方 Skill 无需适配统一语义 Schema，原始结论始终可审计。后续 Skill 需要自行理解前驱输出，长输出可能需要按工件引用读取，阶段 Agent 承担语义汇总职责。只有真实案例证明某个 Skill 无法用原始输出和工件引用交接时，才为该 Skill 设计显式 adapter；MVP 不预留通用 adapter 配置。
