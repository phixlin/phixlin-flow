# 状态协议 v1

本文定义 phixlin-flow 的单文件状态协议。字段名、状态值、Schema 标识和示例中的机器数据保持英文；设计说明、不变量解释和操作指引使用简体中文。

> 中文说明：本文定义 v1 状态协议。字段名、状态值和 Schema 标识是机器接口，保持英文不翻译；章节说明和示例解释以简体中文为准。

首个实现只支持 `phixlin.flow.v1` 这一状态 Schema。规范机器契约见 [`schemas/flow-state-v1.schema.json`](../../schemas/flow-state-v1.schema.json)，跨字段不变量由 `validateChangeState` 强制执行。YAML 仅作为存储语法；重复键、超出解析边界的别名、未知属性、未知 Schema 以及非法字段组合会在加载时失败。

## 文件与信任边界

```text
<repository>/.phixlin/workflows/<name>.yaml       project configuration
<repository>/.phixlin/changes/<change-id>/       user-authored change data
  brief.md
  specs/
  artifacts/                                     不可变证据
  events.jsonl                                   仅用于诊断
  knowledge.md

<control-root>/<repository-id>/<change-id>/       位于 Agent 可写根目录之外
  flow-state.yaml                                唯一恢复控制面
  mutation.lock                                  固定路径目录锁（由 Store 通过 proper-lockfile 管理）
  executor.lock                                  固定 inode advisory lock
  operations/                                    适配器输入/结果暂存
```

控制根目录由 Harness 提供，不能位于 Agent 可写工作区内。状态中的工件路径必须是 change 的 `artifacts/` 目录下的规范化路径；绝对路径、反斜杠和 `..` 遍历均非法。Workflow Skill 资源使用相对于其 `SKILL.md` 的路径，并在创建 Workflow 快照时校验。

## 字段字典

| 字段 | 说明 |
|---|---|
| `schema` | 固定为 `phixlin.flow.v1`；未知版本停止执行。 |
| `change_id` | 在 Shape、修复、重启和完成期间保持不变的用户可见标识。 |
| `state_version` | 从 0 开始，每次提交 mutation 恰好递增 1。 |
| `workspace` | 仓库绝对根目录、仓库身份、基线证据和已确认的可写范围。 |
| `workflow` | 不可变的 Profile 名称、版本、runtime、摘要，以及按顺序解析的 Skill 和资源快照。 |
| `outer` | 交付 `phase`、调度 `status`、单调递增的 `stage_visit` 和候选 `iteration`。 |
| `inner` | 当前唯一的生命周期位置，以及（如存在）唯一的进行中 `operation`。 |
| `budget` | 当前 visit 的 turn、基础设施失败、修复和无进展计数及其上限。 |
| `skills` | 当前 visit 的全部 planned 记录，以及 observed 或 reported 的 contextual 记录。 |
| `stage_context` | 当前修订绑定、planned 完成顺序、执行 ID 和阶段证据。 |
| `brief` | 当前 brief 修订、摘要、不可变副本和人工确认。 |
| `shape` | 冻结的 spec 修订、验收 ID、检查命令 argv 数组和人工批准。 |
| `candidate` | 与 spec、iteration、工作区摘要、证据、构建者和审查者绑定的 Builder Handoff。 |
| `verification` | 与当前候选及完整验收列表绑定的机器检查和 Verifier 结果。 |
| `interaction` | 待回答的问题或批准、当前绑定、回答和精确恢复位置。 |
| `blocker` | 错误码、原因、允许的恢复动作和精确恢复位置。 |
| `finalization` | 与已批准候选绑定的待处理、已准备或已完成归档。 |
| `history` | 有序 mutation 回执；action ID 唯一，版本范围连续。 |

完整结构类型从 `src/contracts/types.ts` 导出。规范示例位于 `fixtures/state/`，包括 `initial.yaml`、`build.yaml`、`verify.yaml` 和 `completed.yaml`。

## 合法组合

| 外层状态 | 要求的内层状态 | 要求的附加记录 |
|---|---|---|
| `active` | `ready`、`executing`、`reconciling`、`evaluating` 或 `stage-ready` | 不得有 interaction 或 blocker |
| `await-user` | `waiting-user` | 匹配的 `interaction` |
| `paused` | 当前阶段允许的任意可恢复或进行中位置 | 保留记录 |
| `blocked` | `blocked` | 匹配的 `blocker` |
| `done` | 仅在 `completed` 中为 `idle` | 不得有 interaction 或 blocker |

动作按阶段限定。Shape 允许 `skill` 和 `agent-work`；Build 另外允许
`capture-candidate` 和 `review-candidate`；Verify 允许 `skill`、`run-checks`、`verify-candidate` 和 `finalize`。`decide(state)` 根据已校验状态推导唯一的下一条控制器命令。`stage-ready` 会保留产生它的位置，使 `advance` 能应用正确的批准、捕获、审查、验证或归档守卫。Agent 输出可以请求就绪，但只有根 reducer 能修改外层阶段。

## 绑定不变量

- `stage_context.binding` 必须匹配 change ID、visit、Workflow 摘要、brief/spec 修订；当 Build 已捕获候选或 Verify 正在消费候选时，还必须匹配当前候选。
- operation 或 interaction 必须携带与 `stage_context` 相同的绑定。
- 每条 planned Skill 记录必须按数组索引、名称和摘要匹配当前阶段快照，并且必须是 host-observed。Contextual 记录不能携带 planned 索引。
- Build 及后续阶段要求已有确认的 Shape 证据。候选必须匹配当前 spec；审查者必须使用独立的宿主执行，并审查相同的候选摘要。
- Verification 必须对每个冻结的验收 ID 恰好覆盖一次，并匹配当前候选。只有所有机器检查和验收结果均通过，才能为 `pass`。
- 人工 Shape 批准和结果批准必须绑定其主题摘要。Agent 执行结果不包含 approval 字段。完成要求已批准的通过验证和已完成归档。

## 外部记录

`schemas/execution-result-v1.schema.json` 是传给 Codex 的结构化结果 Schema。它有意采用 M0 观察到的较小 response-format JSON Schema 子集；Harness 在收取后检查条件约束和唯一性约束。只有 `needs-user` 结果允许包含 questions。`schemas/event-v1.schema.json` 定义只能追加的诊断事件，永远不能覆盖 `flow-state.yaml`。`schemas/reducer-vectors-v1.schema.json` 和 `fixtures/reducer/v1.yaml` 冻结了 M1 必须实现的事件行为。
