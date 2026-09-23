# Windows 状态恢复与宿主提交信封

## Context

Windows 可能在目录锁释放和状态文件替换时短暂返回 `EPERM`、`EBUSY` 或 `EACCES`。原子替换失败会留下 `.tmp` 文件，后续命令没有统一的恢复入口。宿主提交还同时暴露绑定信封和阶段语义结果，缺少稳定的 schema 示例，导致字段缺失与绑定错误难以定位。

## Decision

Store 在持有 mutation lock 后清理遗留的 `flow-state.yaml.*.tmp`，Windows 下对状态替换和临时文件删除执行有限退避重试；清理仍被系统占用时保留文件并让下一次 CLI 调用继续恢复。宿主提交采用 `phixlin.host-envelope.v1`，由 schema 明确定义 `schema`、`operation_id`、`state_version`、`input_digest` 和嵌套 `result`，CLI 分别校验结构和当前 operation 绑定，并报告字段级差异。

## Consequences

Windows 短暂文件占用不会立即阻断可恢复的下一次操作，孤儿临时状态会在下一次加锁时清理；无法在当前窗口删除的文件仍可能短暂残留。宿主需要使用唯一 envelope 格式，外部 `skill_invocations[].output` 会在边界转换为内部证据 artifact；旧的未带 schema 信封不再作为 v1 合法提交格式。
