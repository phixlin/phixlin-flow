# Windows 锁获取重试

## Context

Windows 进程结束后，`proper-lockfile` 的锁目录可能因句柄释放或安全软件扫描暂时无法删除。下一次 CLI 运行会在获取同一个 `mutation.lock` 时收到 `EPERM`；原实现只重试约 250 毫秒，短于 stale 窗口，因此把可恢复的清理竞争误报为锁获取失败。

## Decision

获取锁遇到 Windows 的 `EACCES`、`EBUSY` 或 `EPERM` 时，按递增等待重试，重试总等待时间覆盖当前锁的 stale 窗口。只有超过该窗口仍不能获取，或遇到其他错误，才返回失败。释放和临时文件清理只在 Windows 上忽略同一组短暂清理错误；其他平台继续显式失败。

## Consequences

异常退出后的下一次命令可能等待一个 stale 窗口，但不需要用户手动删除 `mutation.lock`。活跃锁竞争仍由 `proper-lockfile` 的 `LOCK_BUSY` 语义处理；未知文件系统错误不会被吞掉。
