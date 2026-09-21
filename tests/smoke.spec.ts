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
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('phixlin-flow 真实入口', () => {
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
