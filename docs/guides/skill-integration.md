# Skill 接入

Skill 目录必须包含 `SKILL.md`。将本地 Skill 放在 `.agents/skills/<name>/` 或 `.codex/skills/<name>/`，然后把 `<name>` 加入 `.phixlin/workflows/<profile>.yaml` 对应阶段的 `skills` 数组。数组顺序就是 planned Skill 的执行顺序。

`start` 会解析全部 Skill 及其相对资源，将路径、内容摘要和可得的 Git commit 冻结进 Workflow 快照。缺少文件、逃逸仓库的相对路径或同阶段重名 Skill 会在创建 change 前失败。启动后的 Skill 修改不会改变既有 change；创建新 change 才会得到新快照。

planned Skill 是阶段退出门禁。模型自行调用的 contextual Skill 只进入审计记录，不改变 Profile，也不能代替 planned Skill。最小接入示例见 [`examples/workflows/with-skills.yaml`](../../examples/workflows/with-skills.yaml) 和 [`examples/skills/requirements-review/`](../../examples/skills/requirements-review/)。
