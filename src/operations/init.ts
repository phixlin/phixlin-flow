import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import messages from '../i18n/zh-CN.json' with { type: 'json' }

const defaultWorkflow = `version: 1
name: with-skills
workflow: phixlin-flow-v1
runtime: codex
stages:
  shape:
    skills:
      - requirements-review
  build:
    skills: []
  verify:
    skills: []
`

const entrySkill = `---
name: phixlin
description: 根据 .phixlin Workflow 驱动需求澄清、实现、验证和人工确认。用于用户通过 $phixlin 提交需求文本、文档路径或恢复已有 change。
---

在用户的目标项目目录工作。先读取当前目录的 .phixlin/codex/phixlin.md；文件不存在时读取用户主目录的 .phixlin/codex/phixlin.md。其他读取错误直接报告，不跳过。两处都不存在时说明需要执行 phixlin init。

按读到的流程说明处理本次需求或继续已有 change。Workflow 和运行状态由 phixlin CLI 管理，业务 Skill 由 Codex 管理；不要复制 Skill 到 .phixlin，也不要直接改写 flow-state.yaml。
`

const phixlinPrompt = `# phixlin 工作流入口

在当前目标项目中执行 phixlin CLI。需要已安装可执行的 phixlin、Codex 和 Git 仓库。执行 phixlin 时遇到命令不存在，应报告安装问题，不绕过 CLI 手动实现工作流。phixlin-flow 是同一 CLI 的兼容名称。

## 接收需求

用户给出一句话或完整需求时，将原文写入操作系统临时目录中的 UTF-8 brief 文件。用户给出文档路径时读取正文，将需求补充和来源路径一并保存；文件不存在时询问正确路径。不要把用户文本直接拼成 shell 命令。没有需求时先向用户询问。

默认使用 with-skills Workflow；用户明确指定其他已配置 Workflow 时按其指定名称运行。项目 .phixlin/workflows/<name>.yaml 优先，文件不存在时才读取用户主目录 .phixlin/workflows/<name>.yaml。Workflow 格式错误或引用的 Skill 缺失时，报告 CLI 原始错误，停止启动；通过 Codex 管理 Skill，不自动安装业务 Skill、不删除引用、不改用空工作流。

为新需求生成满足 [A-Za-z0-9][A-Za-z0-9._-]{0,127} 的唯一 change-id，然后执行：

    phixlin start <change-id> --workflow <name> --brief <brief-file>
    phixlin status <change-id>

告诉用户 change-id 并在本次对话中持续复用。用户回复问题、批准、要求修改或恢复时继续同一 change；恢复时可读取当前项目 .phixlin/changes 下的状态确定目标，多个候选时询问用户，不创建重复 change。

## 自动推进与人工确认

每次以 status 返回的 next_action、next_command、requires_user 和 state_version 决定下一步。执行命令后重新查询 status，不复用旧版本参数。CLI 输出的工件路径相对于当前项目 .phixlin/changes/<change-id>/，需要内容时读取实际工件。

- 自动动作：执行 next_command；resume 仅准备下一项 operation，不启动 Codex 子进程。返回 executing 时，读取输出中的 input 和 operation，在当前会话中按该阶段的 Skill 指令执行任务；Shape 只制定规格，不修改业务文件；Build 必须等 Shape 明确批准后才实现。完成后把结构化结果写入临时 JSON 文件，执行 status 给出的 submit 命令。提交包必须包含 schema: phixlin.host-envelope.v1、operation_id、当前 state_version、operation.binding.input_digest 和 result。result 包含 kind、summary、questions、proposal、shape、review、verification，未使用的字段为 null 或空数组；Shape 完成时 shape 包含 document、acceptance、checks，其中 acceptance 至少一项，每项的 id、text、verification 不得为空，checks 可为空，但每项 argv 至少含一条命令，标识不得重复；review 包含 verdict、report；verification 包含 verdict、acceptance。提交结果校验失败时检查最新 status，状态仍为 executing 则修正 JSON 并以同一 operation 重交；若旧 change 已在 evaluating 且非法结果使其卡住，按 status 的 resume 进入 blocked，得到用户确认后 retry，再提交修正结果。不得递归调用 $phixlin，不得在没有有效 operation 或工作流停止时直接实现。沿用当前会话权限边界，不自动提升 sandbox 权限。
- question：读取 interaction.questions 中的问题，向用户提问；得到实际回答后写入临时文件，填入 answer 命令的占位符，再继续推进。
- shape-approval：读取状态中 shape.documents 对应的规格工件，展示目标、范围、验收项和检查命令，等待用户明确确认；确认后才执行 confirm-shape。actor 使用用户身份；没有可用身份时向用户询问。
- result-approval：读取候选摘要与验证报告，向用户展示实现、检查结果和已知限制，等待明确接受后才执行 accept-result，然后继续 resume 完成归档。机器验证通过不代表用户接受。
- 用户要求修改结果：将意见写入临时文件，使用 request-changes 和最新 expected-version、expected-action；只有验收契约变化时追加 --requirements-changed。
- budget、blocked、paused 或命令失败：报告原因和可用恢复动作并停止自动推进；用户明确要求恢复或重试后重新查询状态，再执行恢复命令。不要无条件循环 retry。
- done：读取最终交付与验证工件，总结结果并给出 change-id。需要审计包时先执行 export-evidence，再运行 verify-evidence，成功后提供路径。

所有用户交互都在当前 Codex 对话中完成。不要要求用户手动维护 brief、change-id、版本号或执行底层命令。不得伪造回答、批准、验证结果或直接写状态文件。
`

export async function initialize(args: string[], repository: string, userDirectory: string) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--scope' || !['project', 'user'].includes(args[1]))) {
    throw new Error(messages.invalidInitArguments)
  }
  const scope = args[1] ?? 'project'
  const directory = scope === 'project' ? repository : userDirectory
  const root = join(directory, '.phixlin')
  const entryRoot = join(directory, '.agents', 'skills', 'phixlin')
  const workflowRoot = join(root, 'workflows')
  const promptRoot = join(root, 'codex')
  await mkdir(entryRoot, { recursive: true })
  await mkdir(workflowRoot, { recursive: true })
  await mkdir(promptRoot, { recursive: true })
  await writeFile(join(workflowRoot, 'with-skills.yaml'), defaultWorkflow, { flag: 'wx' }).catch((error: unknown) => {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  })
  await writeFile(join(promptRoot, 'phixlin.md'), phixlinPrompt, { flag: 'wx' }).catch((error: unknown) => {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  })
  await writeFile(join(entryRoot, 'SKILL.md'), entrySkill, { flag: 'wx' }).catch((error: unknown) => {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  })
  return { scope, root, entry: join(entryRoot, 'SKILL.md'), workflow: join(workflowRoot, 'with-skills.yaml'), prompt: join(promptRoot, 'phixlin.md') }
}
