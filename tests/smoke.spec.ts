import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { parseChangeStateYaml } from '../src/index.js'

const exec = promisify(execFile)
const roots: string[] = []
async function cleanup(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw error
    // Windows 第三方安全软件可能在重试窗口后仍持有临时目录；不让清理噪声覆盖已完成的测试结果。
  }
}
afterEach(async () => { for (const root of roots.splice(0)) await cleanup(root) })

describe('phixlin-flow 真实入口', { timeout: process.platform === 'win32' ? 180_000 : 30_000 }, () => {
  it('宿主提交完整闭环，禁止越过 Shape 审批且不启动 Agent 子进程', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-host-smoke-'))
    roots.push(root)
    await exec('git', ['init', '-q', root])
    await exec('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'baseline'])
    const bin = join(root, 'bin')
    await mkdir(bin)
    const marker = join(root, '.phixlin', 'agent-started')
    await writeFile(join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), process.platform === 'win32' ? `@echo off\r\necho started > "${marker}"\r\nexit /b 1\r\n` : `#!/bin/sh\nprintf started > '${marker}'\nexit 1\n`)
    await mkdir(join(root, '.phixlin', 'workflows'), { recursive: true })
    await writeFile(join(root, '.phixlin', 'workflows', 'host.yaml'), 'version: 1\nname: host\nworkflow: phixlin-flow-v1\nruntime: codex\nstages:\n  shape:\n    skills: []\n  build:\n    skills: []\n  verify:\n    skills: []\n')
    await writeFile(join(root, 'brief.md'), '绘制鳄鱼骑自行车的动画\n')
    const cli = resolve('dist/src/cli.js')
    const invoke = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` } })).stdout)
    const submit = async (status: { operation: { operation_id: string; binding: { input_digest: string } }; state_version: number; next_action: string }, result: Record<string, unknown>) => {
      const resultFile = join(root, '.phixlin', 'host-result.json')
      await writeFile(resultFile, JSON.stringify({ schema: 'phixlin.host-envelope.v1', operation_id: status.operation.operation_id, state_version: status.state_version, input_digest: status.operation.binding.input_digest, result }))
      return invoke('submit', 'host-change', '--operation', status.operation.operation_id, '--result-file', resultFile, '--expected-version', String(status.state_version), '--expected-action', status.next_action)
    }
    const semantic = (fields: Record<string, unknown> = {}) => ({ kind: 'stage-ready', summary: '完成', questions: [], proposal: null, shape: null, review: null, verification: null, ...fields })
    await invoke('start', 'host-change', '--workflow', 'host', '--brief', 'brief.md')
    let status = await invoke('resume', 'host-change', '--expected-version', '0', '--expected-action', 'agent-work')
    expect(status).toMatchObject({ next_action: 'executing', phase: 'shape', operation: { action: 'agent-work' } })
    expect(status.input).toContain('鳄鱼骑自行车')
    const resumed = await invoke('resume', 'host-change', '--expected-version', String(status.state_version), '--expected-action', 'executing')
    expect(resumed.operation.operation_id).toBe(status.operation.operation_id)
    expect(resumed.input).toBe(status.input)
    const resultFile = join(root, '.phixlin', 'host-result.json')
    await writeFile(resultFile, JSON.stringify({ schema: 'phixlin.host-envelope.v1', operation_id: 'wrong', state_version: status.state_version, input_digest: status.operation.binding.input_digest, result: semantic() }))
    await expect(invoke('submit', 'host-change', '--operation', status.operation.operation_id, '--result-file', resultFile, '--expected-version', String(status.state_version), '--expected-action', 'executing')).rejects.toThrow('宿主结果绑定')
    expect((await invoke('status', 'host-change')).state_version).toBe(status.state_version)
    await writeFile(resultFile, JSON.stringify({ schema: 'phixlin.host-envelope.v1', operation_id: status.operation.operation_id, state_version: status.state_version, input_digest: status.operation.binding.input_digest, result: semantic() }))
    await expect(invoke('submit', 'host-change', '--operation', status.operation.operation_id, '--result-file', resultFile, '--expected-version', String(status.state_version), '--expected-action', 'executing')).rejects.toThrow('Shape 结果缺少规格')
    expect((await invoke('status', 'host-change')).state_version).toBe(status.state_version)
    const blocked = await submit(status, semantic({ kind: 'blocked', summary: '宿主无法完成当前任务' }))
    expect(blocked).toMatchObject({ status: 'blocked', blocker: { reason: '宿主无法完成当前任务', recovery_command: expect.stringContaining('retry host-change') } })
    expect((await invoke('status', 'host-change')).next_action).toBe('blocked')
    const blockedState = parseChangeStateYaml(await readFile(join(root, '.phixlin/changes/host-change/flow-state.yaml'), 'utf8'))
    expect(blockedState.history.at(-1)?.action).toBe('execution-error')
    expect(blockedState.history.at(-1)?.evidence).toHaveLength(1)
    await expect(readFile(join(root, 'crocodile-bike.html'))).rejects.toMatchObject({ code: 'ENOENT' })
    status = await invoke('retry', 'host-change', '--expected-version', String(blocked.state_version), '--expected-action', 'blocked')
    status = await invoke('resume', 'host-change', '--expected-version', String(status.state_version), '--expected-action', 'agent-work')
    status = await submit(status, semantic({ shape: { document: '动画规格', acceptance: [{ id: 'animation', text: '绘制鳄鱼动画', verification: '检查 HTML' }], checks: [] }, skill_invocations: [{ name: 'brainstorming', status: 'completed', output: '动画草图' }] }))
    expect(status).toMatchObject({ phase: 'shape', next_action: 'shape-approval' })
    expect(parseChangeStateYaml(await readFile(join(root, '.phixlin/changes/host-change/flow-state.yaml'), 'utf8')).skills).toContainEqual(expect.objectContaining({ mode: 'contextual', name: 'brainstorming', observation: 'model-reported' }))
    await expect(invoke('submit', 'host-change', '--operation', 'wrong', '--result-file', resultFile, '--expected-version', String(status.state_version), '--expected-action', status.next_action)).rejects.toThrow('operation 不匹配')
    await expect(readFile(join(root, 'crocodile-bike.html'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await invoke('status', 'host-change')).phase).toBe('shape')
    status = await invoke('confirm-shape', 'host-change', '--actor', 'user', '--expected-version', String(status.state_version), '--expected-action', status.next_action)
    status = await invoke('resume', 'host-change', '--expected-version', String(status.state_version), '--expected-action', status.inner?.position?.action ?? 'agent-work')
    expect(status).toMatchObject({ phase: 'build', next_action: 'executing' })
    await writeFile(join(root, 'crocodile-bike.html'), '<svg><text>鳄鱼骑自行车</text></svg>\n')
    status = await submit(status, semantic())
    expect(status).toMatchObject({ phase: 'build', operation: { action: 'review-candidate' } })
    status = await submit(status, semantic({ review: { verdict: 'pass', report: '代码审查通过' } }))
    expect(status).toMatchObject({ phase: 'verify', operation: { action: 'verify-candidate' } })
    status = await submit(status, semantic({ verification: { verdict: 'pass', acceptance: [{ id: 'animation', result: 'pass', reason: '已验证 SVG' }] } }))
    expect(status).toMatchObject({ phase: 'verify', next_action: 'result-approval' })
    status = await invoke('accept-result', 'host-change', '--actor', 'user', '--expected-version', String(status.state_version), '--expected-action', status.next_action)
    status = await invoke('resume', 'host-change', '--expected-version', String(status.state_version), '--expected-action', 'finalize')
    expect(status).toMatchObject({ phase: 'completed', status: 'done' })
    const state = parseChangeStateYaml(await readFile(join(root, '.phixlin/changes/host-change/flow-state.yaml'), 'utf8'))
    expect(state.history.map((event) => event.action)).toContain('finish-verification')
    expect(await readFile(join(root, 'crocodile-bike.html'), 'utf8')).toContain('<svg>')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['project', 'user'])('%s 级初始化后可在当前项目启动带 Skill 的工作流', async (scope) => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-init-smoke-'))
    roots.push(root)
    const project = join(root, 'project')
    const user = join(root, 'user')
    await mkdir(project)
    await mkdir(user)
    const env = { ...process.env, CODEX_HOME: join(root, 'unused-codex') }
    const cli = join(root, 'cli.mjs')
    // 隔离子进程的主目录查询，不修改宿主环境，也不访问真实用户配置。
    await writeFile(cli, `import os from 'node:os';\nimport { syncBuiltinESMExports } from 'node:module';\nos.homedir = () => ${JSON.stringify(user)};\nsyncBuiltinESMExports();\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/src/cli.js')).href)});\n`)
    await exec(process.execPath, [cli, 'init', '--scope', scope], { cwd: project, env })
    const configuration = join(scope === 'project' ? project : user, '.phixlin')
    expect(await readFile(join(configuration, 'workflows/with-skills.yaml'), 'utf8')).toBe(await readFile('examples/workflows/with-skills.yaml', 'utf8'))
    await writeFile(join(project, 'brief.md'), '# 需求\n')
    expect(await readdir(configuration)).toEqual(['codex', 'workflows'])
    // 未安装 Skill 时，即使 .phixlin 中存在同名文件也不能作为 Skill 来源。
    await mkdir(join(configuration, 'skills/requirements-review'), { recursive: true })
    await writeFile(join(configuration, 'skills/requirements-review/SKILL.md'), '# 不应加载\n')
    await expect(exec(process.execPath, [cli, 'start', 'missing-skill', '--workflow', 'with-skills', '--brief', 'brief.md'], { cwd: project, env })).rejects.toThrow('SKILL.md not found')
    await expect(readFile(join(project, '.phixlin/changes/missing-skill/flow-state.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    const skillDirectory = join(scope === 'project' ? project : user, '.agents/skills/requirements-review')
    await mkdir(skillDirectory, { recursive: true })
    const skillContent = await readFile('examples/skills/requirements-review/SKILL.md', 'utf8')
    await writeFile(join(skillDirectory, 'SKILL.md'), skillContent)
    await exec(process.execPath, [cli, 'init', '--scope', scope], { cwd: project, env })
    expect(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).toBe(skillContent)

    await exec(process.execPath, [cli, 'start', 'initialized', '--workflow', 'with-skills', '--brief', 'brief.md'], { cwd: project, env })
    const state = parseChangeStateYaml(await readFile(join(project, '.phixlin/changes/initialized/flow-state.yaml'), 'utf8'))
    expect(state.workflow.name).toBe('with-skills')
    expect(state.workflow.runtime).toBe('codex')
    expect(state.skills[0].name).toBe('requirements-review')
    expect(state.inner).toMatchObject({ state: 'ready', position: { action: 'skill' } })
    await exec(process.execPath, [cli, 'status', 'initialized'], { cwd: project, env })
  })

  it('创建 change 后可从另一个进程读取状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-smoke-'))
    roots.push(root)
    await mkdir(join(root, '.phixlin', 'workflows'), { recursive: true })
    await writeFile(join(root, '.phixlin', 'workflows', 'standard.yaml'), 'version: 1\nname: standard\nworkflow: phixlin-flow-v1\nruntime: codex\nstages:\n  shape:\n    skills: []\n  build:\n    skills: []\n  verify:\n    skills: []\n')
    await writeFile(join(root, 'brief.md'), '# 修复问题\n')
    const cli = resolve('dist/src/cli.js')
    await exec(process.execPath, [cli, 'start', 'smoke-change', '--workflow', 'standard', '--brief', 'brief.md'], { cwd: root })
    const { stdout } = await exec(process.execPath, [cli, 'status', 'smoke-change'], { cwd: root })
    expect(JSON.parse(stdout)).toMatchObject({ change_id: 'smoke-change', state_version: 0, phase: 'shape', status: 'active', next_action: 'agent-work' })
    const changeRoot = join(root, '.phixlin', 'changes', 'smoke-change')
    const state = parseChangeStateYaml(await readFile(join(changeRoot, 'flow-state.yaml'), 'utf8'))
    expect(state.workflow.name).toBe('standard')
    expect(await readFile(join(changeRoot, state.brief.artifact.path), 'utf8')).toBe('# 修复问题\n')
    await exec(process.execPath, [cli, 'pause', 'smoke-change', '--expected-version', '0', '--expected-action', 'agent-work'], { cwd: root })
    const paused = JSON.parse((await exec(process.execPath, [cli, 'status', 'smoke-change'], { cwd: root })).stdout)
    expect(paused).toMatchObject({ state_version: 1, status: 'paused', next_action: 'paused' })
    expect(paused).toMatchObject({ requires_user: true, loop: { state: 'ready' }, skills: { completed: 0, total: 0 } })
    expect(paused.next_command).toContain('resume smoke-change --expected-version 1 --expected-action paused')
    const bundle = join(root, 'evidence-bundle')
    await exec(process.execPath, [cli, 'export-evidence', 'smoke-change', '--output', bundle], { cwd: root })
    const verified = JSON.parse((await exec(process.execPath, [cli, 'verify-evidence', bundle], { cwd: root })).stdout)
    expect(verified).toMatchObject({ valid: true, change_id: 'smoke-change', state_version: 1 })
    await writeFile(join(changeRoot, state.brief.artifact.path), 'corrupted')
    await expect(exec(process.execPath, [cli, 'resume', 'smoke-change', '--expected-version', '1', '--expected-action', 'paused'], { cwd: root })).rejects.toThrow('evidence changed')
    expect(parseChangeStateYaml(await readFile(join(changeRoot, 'flow-state.yaml'), 'utf8')).outer.status).toBe('paused')
  })
})
