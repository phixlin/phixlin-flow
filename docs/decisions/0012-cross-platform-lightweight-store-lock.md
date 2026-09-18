# 0012 跨平台轻量 Store 锁

## Context

Store 需要避免多个 Harness 进程同时基于同一版本提交状态。原实现依赖 `fs-ext` 的原生编译，Windows 开发者安装依赖时必须准备 Python 和 MSVC Build Tools；项目并发量较低，不值得维护跨平台原生锁发布矩阵。

## Decision

使用纯 JavaScript 的 `proper-lockfile` 实现跨进程互斥。锁竞争仍返回 `LOCK_BUSY`，锁通过 heartbeat 防止活进程被接管，进程异常退出后允许在 stale 窗口后恢复。POSIX 继续同步父目录；Windows 跳过 Node 不提供稳定契约的父目录 `fsync`，保留文件同步和原子替换。

## Consequences

Windows 安装不再需要 `fs-ext` 的本地编译工具链，Linux 和 Windows 共用同一锁实现。崩溃锁不再由内核立即释放，恢复延迟受 stale 窗口限制；Windows 断电持久性弱于 POSIX 父目录同步。并发恢复和 stale 行为由 Store 测试覆盖，真实 Codex shell fixture 的 Windows 覆盖暂不扩展。
