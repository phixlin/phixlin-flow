# Context

M3 跑通真实闭环后，恢复仍缺少三个实际使用边界：静止状态无法显式暂停，恢复前没有统一核对全部引用工件，外部进程可在保留版本号时绕过 Store 改写状态。Codex 进程故障和敏感日志也缺少完整故障矩阵。

# Decision

增加 `pause` 与 `resume-state` reducer 动作。暂停只接受没有外部调用正在执行的可恢复生命周期；`resume --max-steps` 可把自动运行停在持久化边界。CLI 在解除暂停前重读所有状态引用工件并验证字节数和 SHA-256。Stage Runner 的 CAS 请求携带调用前完整状态摘要。

人工回答、确认意见和 request-changes 意见保存为不可变工件并进入 history evidence。Codex Adapter 将超时、非零退出和损坏输出映射到确定的失败结果，拒绝工作区外检查，并在写事件前替换已配置敏感值。

# Consequences

正在执行的外部进程不能直接标为 paused；控制器必须先收取结果或确认停止，再在持久化边界暂停。`danger-full-access` 仍允许进程读取工作区内的控制目录，但绕过 Store 的状态改写会在下一次提交时被完整状态摘要发现。更强的读取隔离仍依赖可用的 `workspace-write` 宿主。
