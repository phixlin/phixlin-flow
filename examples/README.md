# 在 Codex 中运行 phixlin

使用流程：初始化 → 启动 Codex → `$phixlin <需求>`。

`phixlin-flow` 是 Harness 控制面：当前 Codex 会话读取 `$phixlin` Skill 并调用 `phixlin` CLI；CLI 管理 change、阶段、证据和审批，不会启动嵌套的 Agent。`resume` 返回 operation 和阶段输入，宿主执行后按 `status` 的 `next_command` 将结果文件交给 `submit`。未获得 Shape 审批，不执行 Build；CLI 自行执行机器检查。

## 安装与初始化

在本工程源码目录安装 CLI（需要 Node.js 22+、pnpm、Git 和已登录的 Codex CLI）：

```bash
pnpm install
pnpm build
pnpm add --global .
```

在目标项目启动 Codex 前，确认终端能找到 CLI：PowerShell 执行 `Get-Command phixlin`，bash 执行 `command -v phixlin`。若找不到，运行 `pnpm setup` 并重新打开终端，返回本工程源码目录重新执行 `pnpm add --global .`；已打开的 Codex 会话也需重启。

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

旧版本已初始化的 `.phixlin/codex/phixlin.md` 不会被 `init` 覆盖。升级后请先备份旧文件，删除旧流程说明并重新运行 `phixlin init`，确认新说明包含 `submit` 和宿主 operation 交接；自定义内容需自行迁移。

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

已有的 Codex CLI 0.150.1 测试确认项目级与用户级入口可以被发现；新的宿主交接协议通过 CLI 冒烟测试，尚未由真实宿主会话完成全程验收。旧子进程模型的 M3 审计记录只作为历史证据，不证明新架构的真实闭环。

该次测试的规格把整个 Git 未跟踪文件列表当成新增业务文件范围，导致初始化配置和已有需求文档被误计入验收，审查反复返回 Build。流程已暂停，未接受失败结果；暂停状态审计包通过完整性校验。测试时请审阅 Shape 的范围检查是否区分已有文件与本次变更；此问题及失败收敛尚未修复。

当前测试宿主的 workspace-write 模式存在 bwrap 权限错误；真实模型测试是在用户明确授权 danger-full-access 后执行的。普通使用保留默认权限策略，无需照搬测试权限设置。
