# Context

初始化应创建 phixlin 自己的配置目录，并支持用户级和当前目录项目级。将用户级配置绑定 CODEX_HOME、将资源写到 .agents 或 .codex 会混淆配置归属。此前未提交的初始化草稿没有验证 Codex slash command 注册能力。

# Decision

提供 phixlin 二进制别名。phixlin init 默认创建当前目录的 .phixlin，--scope user 创建用户主目录的 .phixlin。两者统一保存 workflows、skills 和 codex 流程说明。重复初始化保留已有文件。运行时先读项目 Workflow，只有文件不存在才读取用户 Workflow；项目 Skill 优先，兼容已有项目 Skill 路径，再读取用户 .phixlin/skills。变更状态始终留在当前项目。新增参数错误文案使用 zh-CN 资源。

# Consequences

用户级配置可被多个项目复用，项目可覆盖配置；已有持久化状态格式不变。初始化不会写入 CODEX_HOME，也不会修改其他目录或删除之前创建的文件。codex/phixlin.md 是流程说明，尚不构成 Codex slash command 注册；文档明确保留该限制，不承诺未验证的 /phixlin 入口。
