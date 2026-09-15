import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { parseChangeStateYaml } from '../src/index.js'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('phixlin-flow 真实入口', () => {
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
