# 本地示例

先在一个可修改的 Git 仓库中安装构建后的 CLI，并准备配置目录：

```bash
pnpm install
pnpm build
mkdir -p .phixlin/workflows .agents/skills
```

无 Skill 路径：

```bash
cp examples/workflows/no-skills.yaml .phixlin/workflows/
node dist/src/cli.js start example-no-skills --workflow no-skills --brief examples/briefs/no-skills.md
node dist/src/cli.js status example-no-skills
```

有 Skill 路径：

```bash
cp examples/workflows/with-skills.yaml .phixlin/workflows/
cp -R examples/skills/requirements-review .agents/skills/
node dist/src/cli.js start example-with-skills --workflow with-skills --brief examples/briefs/with-skills.md
node dist/src/cli.js status example-with-skills
```

Verify 失败并修复路径：

```bash
cp examples/workflows/verify-repair.yaml .phixlin/workflows/
node dist/src/cli.js start example-repair --workflow verify-repair --brief examples/briefs/verify-repair.md
node dist/src/cli.js status example-repair
```

每一步都以 `status` 返回的 `next_command` 为准执行。Shape 和结果批准命令中的 `<actor>` 要替换为操作者标识；自动推进命令可按需要追加 `--sandbox workspace-write`。第三条路径的 brief 明确要求首次候选失败，运行记录应出现 `verify -> build -> verify`。

流程完成后导出并离线验证审计包：

```bash
node dist/src/cli.js export-evidence <change-id> --output ./evidence-bundle
node dist/src/cli.js verify-evidence ./evidence-bundle
```
