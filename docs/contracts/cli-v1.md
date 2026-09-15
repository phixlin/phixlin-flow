# CLI 与存储契约 v1

本文面向使用 phixlin-flow 的用户和贡献者。命令名、参数名、状态值、错误码、路径和 Schema 标识属于机器接口，保持英文；本页的解释和操作说明使用简体中文。

> 中文说明：本文定义命令行与存储契约。命令名、参数名、状态值和错误码属于稳定接口，必须保持英文；其余说明面向简体中文用户和贡献者。

首个二进制名称为 `phixlin-flow`。除 `start` 外，每个会修改状态的命令都必须提供 `--expected-version` 和 `--expected-action`；`start` 在持有 mutation lock 的情况下创建版本 0。初始开发、重启、修复、需求修订和完成始终使用同一个 `<change-id>`。

| 命令 | 说明 |
|---|---|
| `start <change-id> --workflow <name> --brief <path>` | 校验 Profile 及全部 Skill 资源，冻结快照，创建 change 目录和初始状态。 |
| `status <change-id> [--json]` | 校验状态并输出 phase、status、版本、推导出的下一动作、预算、交互或阻塞信息。 |
| `resume <change-id>` | 获取 executor lock；派发任何操作前先核对未知操作。 |
| `pause <change-id>` | 停止后续派发并请求中断当前操作；只有收取结果或确认终止后才报告 paused。 |
| `answer <change-id> --interaction <id> --body-file <path>` | 将回答绑定到当前交互并恢复保存的动作；不会批准阶段。 |
| `confirm-shape <change-id> --actor <id>` | 人工操作，绑定当前 brief 和 Shape 摘要，然后开始新的 Build visit。 |
| `accept-result <change-id> --actor <id>` | 人工操作，绑定当前通过候选的摘要，然后使 `finalize` 就绪。 |
| `request-changes <change-id> --body-file <path>` | 使结果批准失效并返回 Build；若验收契约发生变化则返回 Shape。 |
| `switch-workflow <change-id> --workflow <name>` | 冻结新的 Profile 快照，使候选和批准状态失效，并返回 Shape。 |
| `history <change-id> [--json]` | 从主状态读取有序的转换回执。 |
| `export-evidence <change-id> --output <path>` | 导出状态、Workflow 快照、事件、Handoff、报告、清单和已校验的工件索引。 |

如果 Profile 缺失、阶段非法、planned Skill 重复、`SKILL.md` 缺失、引用资源缺失、runtime 不受支持，或控制目录位于 Agent 可写根目录内，`start` 会在创建状态前失败。Build 允许 planned Skill 列表为空，并从 `agent-work` 开始。

事件流使用 `phixlin.event.v1`，每个 change 的 `sequence` 单调递增。事件仅用于诊断：可以报告末行缺失或截断，但不能据此向前或向后推进状态。Skill 输出和适配器结果是不可变工件，名称由宿主创建的 operation 或 invocation ID 决定。控制器会先计算字节数和 SHA-256，再把引用写入状态。
