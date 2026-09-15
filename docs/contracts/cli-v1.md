# CLI and Storage Contract v1

> 中文说明：本文定义命令行与存储契约。命令名、参数名、状态值和错误码属于稳定接口，必须保持英文；其余说明面向简体中文用户和贡献者。

The first binary name is `phixlin-flow`. Every mutating command takes `--expected-version` and
`--expected-action`, except `start`, which creates version 0 while holding the mutation lock.
Commands use a single `<change-id>` for initial work, restart, repair, requirement revision, and
completion.

| Command | Contract |
|---|---|
| `start <change-id> --workflow <name> --brief <path>` | Validate the Profile and all Skill resources, freeze its snapshot, create change directories and initial state. |
| `status <change-id> [--json]` | Validate state and print phase, status, version, derived next action, budgets, interaction, or blocker. |
| `resume <change-id>` | Acquire the executor lock; reconcile an unknown operation before dispatching anything. |
| `pause <change-id>` | Stop future dispatch and request interruption of the current operation; report paused only after result or termination is collected. |
| `answer <change-id> --interaction <id> --body-file <path>` | Bind answers to the current interaction and resume its saved action; never approve a stage. |
| `confirm-shape <change-id> --actor <id>` | Human action binding current brief and Shape digests, then start a new Build visit. |
| `accept-result <change-id> --actor <id>` | Human action binding the current passing candidate digest, then make `finalize` ready. |
| `request-changes <change-id> --body-file <path>` | Invalidate result approval and return to Build, or return to Shape when the requested acceptance contract changes. |
| `switch-workflow <change-id> --workflow <name>` | Freeze a new Profile snapshot, invalidate candidate/approval state, and return to Shape. |
| `history <change-id> [--json]` | Read ordered transition receipts from the main state. |
| `export-evidence <change-id> --output <path>` | Export state, Workflow snapshot, events, Handoffs, reports, manifests, and verified artifact index. |

`start` fails before state creation for a missing Profile, invalid stage, duplicate planned Skill,
missing `SKILL.md`, missing referenced resource, unsupported runtime, or control directory located
inside an Agent writable root. Build permits an empty planned Skill list and begins with
`agent-work`.

The event stream uses `phixlin.event.v1` and monotonically increasing per-change `sequence` values.
Events are diagnostic: a missing or truncated last line can be reported, but it cannot roll state
forward or backward. Skill output and adapter results are immutable artifacts named by host-created
operation or invocation IDs. The controller computes their byte count and SHA-256 before storing
their reference in state.
