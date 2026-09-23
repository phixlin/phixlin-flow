# Windows 冒烟测试与运行时目录

## Context

Windows 企业环境的 Node 进程启动和文件扫描可能明显慢于开发机。冒烟测试每一步都启动独立 CLI 进程，固定 30 秒容易把正常的冷启动误判为超时；测试清理临时目录时，第三方安全软件还可能短暂持有目录句柄并返回 `EBUSY`。项目级初始化同时会生成应当审阅和入库的 Workflow/入口配置，以及不应入库的 change 状态和证据。

## Decision

仅为真实入口冒烟测试设置 Windows 慢宿主超时，并为临时目录删除启用 `maxRetries`/`retryDelay`；已知的 Windows `EBUSY`、`EPERM` 和 `ENOTEMPTY` 清理失败不覆盖测试结果。项目 Git 忽略 `.phixlin/changes/`，保留 `.phixlin/workflows/`、`.phixlin/codex/` 和 `.agents/skills/phixlin/` 供版本控制。

## Consequences

慢速 Windows 宿主可以完成真实入口测试，瞬时目录占用不会导致误报；无法在重试窗口内清理的临时目录可能留在系统临时目录中。初始化配置的变更会进入 Git 审查，运行时状态不会污染工作区。
