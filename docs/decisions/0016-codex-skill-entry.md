# Context

用户选择使用 Codex 原生 $phixlin Skill 入口替代无法通过公开接口注册的 /phixlin。0015 将所有 Skill 安装排除在 init 之外，尚缺少连接 Codex 与 .phixlin 配置的入口。业务 Skill 仍应由 Codex 管理。

# Decision

init 在所选项目或用户目录安装 .agents/skills/phixlin/SKILL.md，作为唯一随初始化安装的入口 Skill。入口按项目优先、用户级兜底读取 .phixlin/codex/phixlin.md，并由 Codex 调用既有 CLI 创建及推进工作流。配置默认使用 with-skills，用户可指定其他 Workflow。入口接收文本或文档路径，保存并复用 change-id，按 status 驱动自动阶段，在澄清与人工批准处等待真实回复。失败、暂停和预算耗尽时停止自动驱动，不提升权限或篡改状态。业务 Skill 不由 init 安装，示例 Skill 补齐 Codex 所需元数据。

# Consequences

用户使用 init → codex → $phixlin 的入口流程。初始化会在 .phixlin 外生成可由 Codex 发现的入口文件；已有配置和入口保留，旧流程说明需用户自行更新。该决定替代 0015 中对入口 Skill 安装的排除，业务 Skill 管理边界不变。既有持久化状态格式和 CLI 人工批准契约不变。机器测试验证初始化和状态链路；另以 Codex CLI 0.150.1 app-server 的 skills/list 验证项目及用户级入口均可被真实宿主发现，这不等同于真实模型完成交付的验证。
