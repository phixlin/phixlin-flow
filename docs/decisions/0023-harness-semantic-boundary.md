# Harness 与宿主语义边界

## Context

工程同时使用了宿主 Agent、Runtime 和 Git 证据等术语，容易让人误解为 Harness 能理解需求、解释差异或启动模型。Harness 的职责是控制面和可审计交接；Codex 宿主才拥有需求理解、Skill 调用、代码修改和语义结论能力。

## Decision

Codex 宿主负责需求理解、模型和 Skill 调用、工作区修改、Git 差异解释，以及 Shape、Review、Verification 等语义结果。Harness 只负责校验宿主提交包及其 operation/version/input 绑定，采集 Git 状态、差异、文件摘要和机器检查的原始事实，计算哈希，执行 reducer/CAS、审批、审计和恢复。Harness 不启动 Codex、Claude 或其他 Agent，也不根据 Git 差异判断需求是否满足。生产 CLI 的 `StageRunner` 只通过 `prepare` 预留宿主 operation；生产 Runtime 仅用于冻结机器检查和候选漂移检测。通用 `RuntimeAdapter` 仅保留为测试替身接口。

## Consequences

Harness 的 `pass`/`fail` 机器检查结果表示命令退出事实，不表示业务验收结论；候选摘要表示身份和漂移检测，不表示质量判断。错误处理应围绕证据采集、状态持久化和协议绑定提供诊断。任何需要扩展宿主语义输入的协议变更，必须新增版本或单独决策，不能把解释逻辑塞回 Harness。
