# 在 Codex 中运行 phixlin

使用流程：初始化 → 启动 Codex → `$phixlin <需求>`。

## 安装与初始化

在本工程源码目录安装 CLI（需要 Node.js 22+、pnpm、Git 和已登录的 Codex CLI）：

```bash
pnpm install
pnpm build
pnpm link --global
```

进入目标 Git 项目，选择一种作用域初始化：

```bash
cd /path/to/your-project

# 当前项目
phixlin init

# 或用户级，供多个项目使用
phixlin init --scope user
```

项目级会生成：

```text
.phixlin/
├── workflows/with-skills.yaml
└── codex/phixlin.md
.agents/skills/phixlin/SKILL.md
```

用户级在用户主目录生成同样的结构：`~/.phixlin/` 和 `~/.agents/skills/phixlin/`。重复初始化保留已有文件并补齐缺失文件，不覆盖自定义配置。`init` 安装的 `phixlin` 是 Codex 入口 Skill，业务 Skill 的安装与更新仍由 Codex 管理。

## 提交需求

在目标项目启动 Codex：

```bash
codex
```

先通过 Codex 确保 Workflow 引用的业务 Skill 已安装。默认 [with-skills.yaml](workflows/with-skills.yaml) 引用了 `requirements-review`，本工程提供了 [示例 Skill](skills/requirements-review/SKILL.md)；可以让 Codex 安装此本地目录，或使用你已安装并配置好的业务 Skill。`init` 不会代装它们。

然后在 **Codex 对话中**输入以下任意一种需求：

```text
$phixlin 为设置页增加深色模式，并补充自动化测试
$phixlin docs/requirements/dark-mode.md
$phixlin 根据以下文档实现：……
```

入口由 Codex 原生 Skill 机制发现；如果旧会话未看到它，重新启动 Codex。调用形式是 `$phixlin`。

Codex 将自动读取需求，生成 brief 和 change-id，按 Workflow 推进 Shape、Build、Verify 和归档。需要澄清、规格批准或结果接受时，会在当前对话中向你提问。回复后继续同一个 change，不需要手动执行底层命令。机器验证通过后仍需明确接受结果。

暂停后可输入 `$phixlin 继续 <change-id>`。失败时会报告原因和恢复动作，不会自动跳过错误或无限重试。

## 配置与资源

默认使用 `with-skills`；可以编辑 `.phixlin/workflows/with-skills.yaml`，或在需求中明确指定其他已配置的 Workflow 名称。项目 Workflow 优先，文件不存在时读取 `~/.phixlin/workflows/`；格式有误直接报错。Codex 流程说明也按项目优先、用户级兜底读取。

业务 Skill 从项目和用户 `.agents/skills/` 读取，并兼容项目 `.codex/skills/` 与 `$CODEX_HOME/skills/`（默认 `~/.codex/skills/`）。Skill 缺失会阻止启动；不创建、不读取 `.phixlin/skills/`。状态和审计工件始终保存在当前项目 `.phixlin/changes/`。

需要直接诊断或导出审计包时：

```bash
phixlin status <change-id>
phixlin export-evidence <change-id> --output ./evidence-bundle
phixlin verify-evidence ./evidence-bundle
```

## 当前验证范围与已知问题

已通过 200 项单元测试、3 项 CLI 冒烟测试、构建及 lint；Codex CLI 0.150.1 已实际发现项目级与用户级入口。真实模型测试完成了需求文档读取、业务 Skill 执行、规格确认和文件实现，但尚未通过完整交付闭环。

该次测试的规格把整个 Git 未跟踪文件列表当成新增业务文件范围，导致初始化配置和已有需求文档被误计入验收，审查反复返回 Build。流程已暂停，未接受失败结果；暂停状态审计包通过完整性校验。测试时请审阅 Shape 的范围检查是否区分已有文件与本次变更；此问题及失败收敛尚未修复。

当前测试宿主的 workspace-write 模式存在 bwrap 权限错误；真实模型测试是在用户明确授权 danger-full-access 后执行的。普通使用保留默认权限策略，无需照搬测试权限设置。
