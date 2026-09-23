# Shape 结果预校验与旧状态恢复

## Context

`host-result-v1` 允许空 `shape.acceptance`，但持久化的 `flow-state-v1` 要求至少一项。旧实现先记录结果并进入 `evaluating`，再由 `publish-shape` 发现状态不合法；此后 `resume` 会反复重放同一证据。已有 v1 格式不能原地改写。

## Decision

保持既有 schema 不变，在宿主提交边界和 Stage Runner 提交前复用 `flow-state-v1` 对验收项及检查项的约束，并检查标识唯一性。非法结果在记录执行结果前失败，允许宿主修正后以同一 operation 重交。对旧版本已记录在 `evaluating` 的非法 Shape 结果，`resume` 保留证据并转为可人工 `retry` 的 blocker，不修改历史记录或原始工件。

## Consequences

新提交不会因 Shape 验收约束冲突而留下无法推进的状态；旧 change 可以通过 `resume → retry → submit` 恢复。外部 v1 schema 仍允许空验收项，实际提交门禁比该 schema 更严格；日后若发布新的持久化协议，应在新版本中消除这一静态差异。
