# 0002 项目级 Workflow Profile 与双通道 Skill 调用

## Context

Skill 编排通常是项目长期复用的工程约束，一个项目需要支持多套预设流程。将编排文件绑定到单个 change 会造成重复配置，也会混淆需求数据与项目执行策略。同时，编码 Agent 可能根据当前上下文调用编排之外的 Skill；完全禁止这种行为会限制模型处理未知情况的能力。

## Decision

Workflow Profile 存放在项目 `.phixlin/workflows/` 下，一个项目可以定义多个 Profile。创建或启动 change 时选择一个 Profile，change 状态保存名称、版本、内容摘要和解析后的执行快照，用于恢复和审计；Profile 后续修改只影响新 change。

Skill 调用分为两类：

- `planned`：来自 Profile，控制器按顺序显式派发，全部完成是阶段退出条件。
- `contextual`：模型根据上下文触发的计划外 Skill，不要求发生或固定顺序，只记录调用和产物，不改变 planned 指针和阶段门禁。

contextual Skill 不能修改 Workflow 快照或直接推进阶段。Runtime 提供可信调用事件时记录为 observed；只有模型声明时记录为 reported。

## Consequences

项目可以集中维护并复用多套 Skill 工作流，change 保持为需求和交付状态的管理单元。已启动 change 仍有稳定的恢复输入，不受项目配置漂移影响。状态 Schema 和审计记录需要区分 planned/contextual 及 observed/reported。MVP 不实现模型动态修改 Profile、contextual Skill 强制顺序或 contextual Skill 的独立完成门禁。
