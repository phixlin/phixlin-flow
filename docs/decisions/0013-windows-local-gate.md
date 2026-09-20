# 0013 Windows 本地门禁契约

## Context

README 已承诺 Windows 开发环境可以执行完整本地门禁，但 Skill Resolver 把 Windows 路径分隔符判为逃逸，状态 Schema 只接受 POSIX 绝对路径，Git 默认换行转换还会改变按原始字节校验的 fixture 和 evidence。两个端到端测试在 Windows 文件系统上也会越过 Vitest 默认的五秒超时。现有 CI 仅覆盖 Ubuntu，无法发现这些回归；项目声明的 pnpm 版本与构建脚本许可也未入库。

## Decision

Skill Resolver 按当前平台的绝对路径和父目录语义判断 root 边界，仅在 POSIX 上继续拒绝文件名中的反斜杠。`workspace.root` 接受 POSIX、Windows 盘符和 UNC 绝对路径。仓库文本统一以 LF 检出，Vitest 超时显式设为三十秒。项目固定使用 pnpm 12.4.2，并在 workspace 配置中拒绝 `lefthook` 安装脚本。CI 的单元测试同时在 Ubuntu 和 Windows 运行，覆盖率仍只由 Ubuntu 收集。

## Consequences

Windows 可以解析和加载 Skill、创建 change，并稳定执行本地门禁；按字节保存的证据不会再受 Git 换行配置影响。CI 时间会因 Windows 测试增加，三十秒超时也会延后真实死锁的失败反馈。状态 v1 的 `workspace.root` 接受更多平台原生绝对路径，但仍拒绝盘符相对路径和单反斜杠开头的非 UNC 路径。真实 Codex shell fixture 仍不在 Windows 上运行。
