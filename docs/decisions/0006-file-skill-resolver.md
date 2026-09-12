# 0006 文件系统 Skill Resolver

## Context

M2 需要在创建 Workflow 快照时解析项目本地 Skill 和开源仓库子目录 Skill。首期没有 Skill Manifest，解析失败和资源缺失必须在阶段启动前暴露。

## Decision

实现 `FileSkillResolver`，只在调用方提供的 Skill 根目录中按名称查找 `<name>/SKILL.md`，也支持仓库根下的相对 `SKILL.md` 引用。Resolver 递归读取 Skill 目录的文件作为资源快照，并校验 Markdown 中显式引用的 `references/`、`scripts/`、`assets/` 资源存在且不越界；名称优先使用 front matter 的 `name`。

## Consequences

Profile 不需要新增字段即可支持本地和子目录 Skill，缺失资源会阻止快照创建。Resolver 不解析自然语言中的任意路径，也不探测仓库外文件；更复杂的依赖声明需要后续显式 Manifest 决策。
