import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildStatus, exportEvidenceBundle, parseChangeStateYaml, verifyEvidenceBundle } from '../../src/index.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('运行状态查询', () => {
  it('给出阶段、loop、Skill 进度、最近事件和人工审批命令', async () => {
    const state = parseChangeStateYaml(await readFile('fixtures/state/verify.yaml', 'utf8'))
    const status = buildStatus(state)
    expect(status).toMatchObject({
      phase: 'verify',
      status: 'await-user',
      stage_visit: state.outer.stage_visit,
      iteration: state.outer.iteration,
      requires_user: true,
      next_action: 'result-approval',
      loop: { state: 'waiting-user' },
      skills: { completed: 1, total: 1 },
    })
    expect(status.next_command).toContain(`accept-result ${state.change_id}`)
    expect(status.next_command).toContain(`--expected-version ${state.state_version}`)
    expect(status.recent_events).toEqual(state.history.slice(-5))
  })

  it('在可重试 blocker 上给出恢复命令', async () => {
    const state = parseChangeStateYaml(await readFile('fixtures/state/build.yaml', 'utf8'))
    state.outer.status = 'blocked'
    state.inner = { state: 'blocked', position: { action: 'agent-work', skill_index: null, turn: 1, attempt: 1 }, blocker_id: 'blocked-1' }
    state.blocker = { id: 'blocked-1', code: 'EXECUTION_FAILED', reason: '执行失败', allowed_actions: ['retry'], resume: { state: 'ready', position: { action: 'agent-work', skill_index: null, turn: 1, attempt: 1 } } }
    const status = buildStatus(state)
    expect(status).toMatchObject({ requires_user: true, next_action: 'blocked' })
    expect(status.blocker?.recovery_command).toContain(`retry ${state.change_id}`)
  })

  it.each([
    ['shape-approval', 'confirm-shape'],
    ['question', 'answer'],
  ] as const)('为 %s 交互给出对应命令', async (kind, command) => {
    const state = parseChangeStateYaml(await readFile('fixtures/state/verify.yaml', 'utf8'))
    state.interaction!.kind = kind
    const status = buildStatus(state)
    expect(status.next_action).toBe(kind)
    expect(status.next_command).toContain(command)
  })

  it('区分暂停、不可重试 blocker、完成和普通推进状态', async () => {
    const paused = parseChangeStateYaml(await readFile('fixtures/state/build.yaml', 'utf8'))
    paused.outer.status = 'paused'
    expect(buildStatus(paused).next_command).toContain('resume')

    const blocked = parseChangeStateYaml(await readFile('fixtures/state/build.yaml', 'utf8'))
    blocked.outer.status = 'blocked'
    blocked.inner = { state: 'blocked', position: { action: 'agent-work', skill_index: null, turn: 1, attempt: 1 }, blocker_id: 'blocked-1' }
    blocked.blocker = { id: 'blocked-1', code: 'EXECUTION_FAILED', reason: '执行失败', allowed_actions: ['inspect'], resume: { state: 'ready', position: { action: 'agent-work', skill_index: null, turn: 1, attempt: 1 } } }
    expect(buildStatus(blocked).next_command).toBeNull()

    const done = parseChangeStateYaml(await readFile('fixtures/state/completed.yaml', 'utf8'))
    expect(buildStatus(done).next_command).toBeNull()

    const active = parseChangeStateYaml(await readFile('fixtures/state/build.yaml', 'utf8'))
    expect(buildStatus(active).next_command).toContain('resume')
    expect(buildStatus(active, 1).recent_events).toEqual(active.history.slice(-1))
  })
})

describe('审计包', () => {
  async function bundle() {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-evidence-'))
    roots.push(root)
    const source = 'docs/evidence/m3/real-bugfix-full'
    const state = parseChangeStateYaml(await readFile(join(source, 'flow-state.yaml'), 'utf8'))
    const output = join(root, 'bundle')
    const manifest = await exportEvidenceBundle(state, source, output)
    return { output, manifest }
  }

  it('导出状态、Workflow 和全部引用工件并可离线校验', async () => {
    const { output, manifest } = await bundle()
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'flow-state.yaml', kind: 'state' }),
      expect.objectContaining({ path: 'workflow.json', kind: 'workflow' }),
      expect.objectContaining({ path: expect.stringMatching(/^artifacts\//) }),
    ]))
    await expect(verifyEvidenceBundle(output)).resolves.toMatchObject({ valid: true, change_id: manifest.change_id, files: manifest.files.length })
  })

  it.each(['tampered', 'missing', 'extra'] as const)('拒绝 %s 文件集合', async (fault) => {
    const { output, manifest } = await bundle()
    const artifact = manifest.files.find((file) => file.path.startsWith('artifacts/'))!
    if (fault === 'tampered') await writeFile(join(output, artifact.path), 'tampered')
    if (fault === 'missing') await unlink(join(output, artifact.path))
    if (fault === 'extra') await writeFile(join(output, 'extra.txt'), 'extra')
    await expect(verifyEvidenceBundle(output)).rejects.toThrow('审计包')
  })

  it('拒绝与状态不一致的 Workflow 快照', async () => {
    const { output } = await bundle()
    const clone = join(output, '..', 'clone')
    await cp(output, clone, { recursive: true })
    const manifestPath = join(clone, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const workflowPath = join(clone, 'workflow.json')
    const workflow = JSON.parse(await readFile(workflowPath, 'utf8'))
    workflow.name = 'changed'
    const bytes = Buffer.from(`${JSON.stringify(workflow, null, 2)}\n`)
    await writeFile(workflowPath, bytes)
    const record = manifest.files.find((file: { path: string }) => file.path === 'workflow.json')
    const { createHash } = await import('node:crypto')
    record.bytes = bytes.length
    record.sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await expect(verifyEvidenceBundle(clone)).rejects.toThrow('Workflow 与状态快照不一致')
  })
})
