# CLI 与存储契约 v1

本文面向使用 phixlin-flow 的用户和贡献者。命令名、参数名、状态值、错误码、路径和 Schema 标识属于机器接口，保持英文；本页的解释和操作说明使用简体中文。

> 中文说明：本文定义命令行与存储契约。命令名、参数名、状态值和错误码属于稳定接口，必须保持英文；其余说明面向简体中文用户和贡献者。

二进制名称为 `phixlin-flow`，别名为 `phixlin`。除初始化命令和 `start` 外，每个会修改状态的命令都必须提供 `--expected-version` 和 `--expected-action`；`start` 在持有 mutation lock 的情况下创建版本 0。初始开发、重启、修复、需求修订和完成始终使用同一个 `<change-id>`。

| 命令 | 说明 |
|---|---|
| `init [--scope project\|user]` | 默认初始化当前目录 `.phixlin`；用户级为 `~/.phixlin`。生成 Workflow、Codex 流程说明和对应作用域 `.agents/skills/phixlin/SKILL.md` 入口，保留已有文件。业务 Skill 由 Codex 管理。 |
| `start <change-id> --workflow <name> --brief <path>` | 校验 Profile 及全部 Skill 资源，冻结快照，创建 change 目录和初始状态。 |
| `status <change-id> [--json]` | 校验状态并输出阶段、loop、Skill 进度、最近事件、人工介入标记和绑定当前版本的下一命令。 |
| `resume <change-id>` | 获取 executor lock；派发任何操作前先核对未知操作。 |
| `retry <change-id>` | 人工解除允许重试的 blocker，恢复其保存位置并重置连续执行失败计数。 |
| `pause <change-id>` | 停止后续派发并请求中断当前操作；只有收取结果或确认终止后才报告 paused。 |
| `answer <change-id> --interaction <id> --body-file <path>` | 将回答绑定到当前交互并恢复保存的动作；不会批准阶段。 |
| `confirm-shape <change-id> --actor <id>` | 人工操作，绑定当前 brief 和 Shape 摘要，然后开始新的 Build visit。 |
| `accept-result <change-id> --actor <id>` | 人工操作，绑定当前通过候选的摘要，然后使 `finalize` 就绪。 |
| `request-changes <change-id> --body-file <path>` | 使结果批准失效并返回 Build；若验收契约发生变化则返回 Shape。 |
| `switch-workflow <change-id> --workflow <name>` | 冻结新的 Profile 快照，使候选和批准状态失效，并返回 Shape。 |
| `history <change-id> [--json]` | 从主状态读取有序的转换回执。 |
| `export-evidence <change-id> --output <path>` | 导出状态、Workflow 快照、事件、Handoff、报告、清单和已校验的工件索引。 |
| `verify-evidence <bundle-path>` | 不读取项目状态，离线校验审计包的文件集合、字节数、SHA-256 和快照一致性。 |

如果 Profile 缺失、阶段非法、planned Skill 重复、`SKILL.md` 缺失、引用资源缺失或 runtime 不受支持，`start` 会在创建状态前失败。Build 允许 planned Skill 列表为空，并从 `agent-work` 开始。使用 `danger-full-access` 时，控制目录没有读取隔离；Stage Runner 通过调用前完整状态摘要检测外部进程绕过 Store 的改写。

`resume` 支持 `--max-steps <n>` 在持久化边界停止本次驱动，并支持 `--sensitive-values-file <path>` 加载非空字符串 JSON 数组。匹配值会在 Codex stdout/stderr 写入事件工件前替换为 `[REDACTED]`。

事件流使用 `phixlin.event.v1`，每个 change 的 `sequence` 单调递增。事件仅用于诊断：可以报告末行缺失或截断，但不能据此向前或向后推进状态。Skill 输出和适配器结果是不可变工件，名称由宿主创建的 operation 或 invocation ID 决定。控制器会先计算字节数和 SHA-256，再把引用写入状态。

`status` 的 `requires_user` 在 `await-user`、`blocked` 和 `paused` 时为 `true`。`next_command` 可包含 `<actor>`、`<answer-file>` 等必须由操作者替换的占位符；每次状态变化后都应重新查询，不能复用旧版本命令。`recent_events` 默认返回最后五条主状态转换。

审计包 `manifest.json` 使用 `phixlin.evidence-manifest.v1`，其 `files` 覆盖状态、Workflow 和全部递归引用工件，并为每项记录 `kind`、`bytes` 和 `sha256`。manifest 不列出自身；校验时只允许 manifest 与 `files` 中的路径。该格式提供完整性检测，不提供发布者身份签名。

Workflow 优先从当前项目 `.phixlin/workflows/` 加载，文件缺失时才从用户主目录 `.phixlin/workflows/` 加载。Skill 按项目 `.agents/skills/`、`.codex/skills/`、用户 `.agents/skills/`、`$CODEX_HOME/skills/`（默认 `~/.codex/skills/`）顺序解析。初始化只安装 phixlin 入口，不安装或修改业务 Skill，Workflow 仅引用已有 Skill，不读取 `.phixlin/skills/`。初始化不依赖 `CODEX_HOME`，状态仍保存在当前项目中。Codex 流程说明位于所选 `.phixlin/codex/phixlin.md`，Codex 通过对应作用域 `.agents/skills/phixlin/SKILL.md` 发现入口，以 `$phixlin <需求>` 调用。
