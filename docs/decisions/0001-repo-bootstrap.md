# 仓库工程骨架初始化

## Context

仓库需要支持单人和多 agent 协作，并建立可审计的工程门禁。

## Decision

采用 TypeScript、Node.js 22、pnpm、Vitest 和 oxlint；覆盖率 lines 与 branches 阈值设为 90%；启用 correctness、no-empty 和 no-unused-vars lint 规则；现有技术文档移入 `docs/`。

## Consequences

开发和 CI 使用同一套命令与门禁。暂无 CLI 入口，因此冒烟测试先验证包入口导出；未来增加 CLI 时替换为构建产物测试。
