# Windows 锁目录清理

## Context

Store 使用 `proper-lockfile` 创建目录锁。旧实现把目标锁路径作为待锁文件传入，导致库在其后追加 `.lock`，与文档约定的固定 `mutation.lock` 不一致。Windows 在文件句柄释放或安全软件扫描期间可能暂时拒绝删除锁目录；清理异常从 `finally` 冒泡后，会让已经成功写入的状态看起来像 CLI 失败，诱导调用方手动删除锁目录。

## Decision

以 `flow-state.yaml` 作为锁目标，并显式把 `<change>/mutation.lock` 作为 `proper-lockfile` 的 `lockfilePath`。释放锁时，`EACCES`、`EBUSY` 和 `EPERM` 视为 Windows 清理竞争：不回滚已完成的状态提交，也不要求调用方删除目录；保留的目录由 stale 机制在后续获取时回收。其他释放错误继续抛出。

## Consequences

锁目录路径与契约一致，避免生成二级 `.lock` 目录。Windows 短暂清理失败不会阻断工作流，但后续竞争者可能要等待 stale 窗口；未知清理错误仍会显式失败。Store 测试通过注入锁实现验证这一边界。
