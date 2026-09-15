# 失败恢复手册

先运行 `phixlin-flow status <change-id>`。`requires_user` 表示是否必须人工处理；`next_command` 是绑定当前版本和动作的建议命令。不要沿用旧 status 中的命令，版本变化后应重新查询。

| 状态 | 处理方式 |
|---|---|
| `active` | 执行 `next_command` 继续推进。 |
| `await-user` + `question` | 将回答写入文件并执行 `answer` 建议命令。 |
| `await-user` + `shape-approval` | 审查 Shape 工件后执行 `confirm-shape`。 |
| `await-user` + `result-approval` | 审查 Verify 报告后执行 `accept-result` 或 `request-changes`。 |
| `paused` | 核对外部执行已停止，再执行 `resume` 建议命令。 |
| `blocked` | 阅读 `blocker.reason` 和 `allowed_actions`；存在 `retry` 时使用 `recovery_command`。没有恢复命令时保留现场并人工处理根因。 |
| `done` | 无需恢复，可导出审计包。 |

`RESOURCE_DRIFT` 表示状态引用的不可变工件已变化。不要覆盖原摘要或跳过校验；从可信备份恢复对应文件，或保留 change 目录并重新启动一个 change。`EXECUTION_UNKNOWN` 表示进程边界中断后无法判断外部副作用，必须先核对工作区和运行结果，再按 blocker 允许的动作处理。

使用 `export-evidence` 后立即运行 `verify-evidence <bundle-path>`。该命令不读取项目或 change 存储，仅使用审计包内容；删除、修改、增加文件，以及状态与 Workflow 不一致都会失败。
