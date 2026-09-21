# Context

0014 将 Skill 内容放入 .phixlin，与用户明确要求由 Codex 管理 Skill 的职责划分不符。

# Decision

替代 0014 中有关 Skill 存储与发现的决定：init 只生成 Workflow 和 Codex 流程说明，不安装、复制、更新或删除 Skill。Workflow 保留 Skill 名称引用。CLI 从项目和用户 .agents/skills 读取已安装资源，兼容已有项目 .codex/skills 和用户 CODEX_HOME/skills，以便冻结摘要和执行现有审计契约。

# Consequences

.phixlin 不再创建或读取 skills 子目录；已有文件保留而不迁移或删除。缺少 Workflow 引用的 Skill 时启动失败，用户通过 Codex 管理安装。初始化测试改为验证不生成 Skill；入口测试验证未安装时失败、Codex 目录安装后成功，以及初始化不修改已安装资源。其他状态、执行及人工批准契约不变。
