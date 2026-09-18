import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeRuntime, FileEvidenceStore, FileSkillResolver, FileStateMutationStore, StageRunner, createWorkflowSnapshot, parseChangeStateYaml, digestJson } from '../../src/index.js'
import type { RuntimeInput, RuntimeResult } from '../../src/index.js'

const roots: string[] = []
const skills = new FileSkillResolver({ roots: ['fixtures/codex-skills'] })
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const ready = (extra: Partial<RuntimeResult> = {}): RuntimeResult => ({ kind: 'stage-ready', summary: 'ready', artifacts: [], questions: [], proposal: null, ...extra })

async function setup(fixture = 'build') {
  const root = await mkdtemp(join(tmpdir(), 'phixlin-m2-'))
  roots.push(root)
  const state = parseChangeStateYaml(await readFile(`fixtures/state/${fixture}.yaml`, 'utf8'))
  state.workflow = await createWorkflowSnapshot({ version: 1, name: 'm2-test', workflow: 'phixlin-flow-v1', runtime: 'codex', stages: { shape: { skills: ['outline'] }, build: { skills: [] }, verify: { skills: ['summarize'] } } }, (name) => skills.resolve(name))
  state.stage_context.binding.workflow_digest = state.workflow.digest
  if (state.interaction) state.interaction.binding.workflow_digest = state.workflow.digest
  if (fixture === 'initial') state.skills[0] = { ...state.skills[0], name: 'outline', source_digest: state.workflow.stages.shape[0].digest }
  if (fixture === 'verify') {
    state.skills[0] = { ...state.skills[0], name: 'summarize', source_digest: state.workflow.stages.verify[0].digest }
    state.stage_context.planned_completed = ['summarize']
  }
  await mkdir(join(root, state.change_id))
  const evidence = new FileEvidenceStore(root)
  const artifact = await evidence.write('real candidate evidence')
  const inputArtifact = await evidence.write('frozen brief and specification')
  state.workspace.baseline = inputArtifact
  state.brief.artifact = inputArtifact
  state.brief.digest = inputArtifact.sha256
  if (state.brief.confirmed) state.brief.confirmed.subject_digest = inputArtifact.sha256
  if (state.shape) {
    state.shape.documents = [inputArtifact]
    state.shape.digest = digestJson({ documents: state.shape.documents, acceptance: state.shape.acceptance, checks: state.shape.checks })
    if (state.shape.approval) state.shape.approval.subject_digest = state.shape.digest
  }
  await writeFile(join(root, state.change_id, 'flow-state.yaml'), stringify(state))
  const store = new FileStateMutationStore(root)
  return { root, state, store, evidence, artifact }
}

describe('M2 file-backed orchestration', () => {
  it('将 Runtime blocked 结果转为 blocker', async () => {
    const { state, root, store, evidence } = await setup()
    state.budget.execution_failure_limit = 1
    await writeFile(join(root, state.change_id, 'flow-state.yaml'), stringify(state))
    const result = await new StageRunner(store, new FakeRuntime([ready({ kind: 'blocked', summary: 'runtime failed' })]), { evidence, skills }).drive(state.change_id)
    expect(result.state).toMatchObject({ outer: { status: 'blocked' }, blocker: { code: 'EXECUTION_FAILED' } })
  })

  it('拒绝缺少独立复审结果的 stage-ready 输出', async () => {
    const { state, store, evidence, artifact } = await setup()
    const runtime = new FakeRuntime([
      ready({ candidate: { candidate_digest: artifact.sha256, file_manifest: artifact, diff: artifact, summary: 'built', addressed_acceptance_ids: ['A1'], known_limits: [] } }),
      ready(),
    ])
    await expect(new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)).rejects.toThrow('review output missing')
  })

  it('在显式步数预算耗尽时返回当前决策', async () => {
    const { state, store, evidence } = await setup()
    const result = await new StageRunner(store, new FakeRuntime(), { evidence, skills }).drive(state.change_id, 0)
    expect(result).toMatchObject({ steps: 0, decision: { kind: 'dispatch' } })
  })

  it.each(['missing-checks', 'check-error', 'missing-verification'] as const)('拒绝或阻断 %s Runtime 输出', async (fault) => {
    const { state, root, store, evidence, artifact } = await setup()
    state.budget.execution_failure_limit = 1
    await writeFile(join(root, state.change_id, 'flow-state.yaml'), stringify(state))
    const outcomes: (RuntimeResult | ((input: RuntimeInput) => RuntimeResult))[] = [
      ready({ candidate: { candidate_digest: artifact.sha256, file_manifest: artifact, diff: artifact, summary: 'built', addressed_acceptance_ids: ['A1'], known_limits: [] } }),
      (input) => ready({ review: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', report: artifact } }),
      ready(),
    ]
    if (fault === 'missing-checks') outcomes.push(ready())
    else {
      outcomes.push((input) => ready({ checks: input.state.shape!.checks.map(({ id }) => ({ id, result: fault === 'check-error' ? 'error' : 'pass', exit_code: fault === 'check-error' ? null : 0, report: artifact })) }))
      if (fault === 'missing-verification') outcomes.push(ready())
    }
    const drive = new StageRunner(store, new FakeRuntime(outcomes), { evidence, skills }).drive(state.change_id)
    if (fault === 'check-error') expect((await drive).state.outer.status).toBe('blocked')
    else await expect(drive).rejects.toThrow(fault === 'missing-checks' ? 'host checks missing' : 'verifier output missing')
  })

  it('rechecks every acceptance item and detects a regression introduced by repair', async () => {
    const { root, state, store, evidence, artifact } = await setup()
    state.shape!.acceptance.push({ id: 'A2', text: 'preserve order', verification: 'compare order' })
    await writeFile(join(root, state.change_id, 'flow-state.yaml'), stringify(state))
    const outcomes: (RuntimeResult | ((input: RuntimeInput) => RuntimeResult))[] = []
    for (const failure of ['A2', 'A1', null]) {
      outcomes.push(
        ready({ candidate: { candidate_digest: artifact.sha256, file_manifest: artifact, diff: artifact, summary: 'repaired', addressed_acceptance_ids: ['A1', 'A2'], known_limits: [] } }),
        (input) => ready({ review: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', report: artifact } }),
        ready(),
        (input) => ready({ checks: input.state.shape!.checks.map(({ id }) => ({ id, result: 'pass', exit_code: 0, report: artifact })) }),
        (input) => ready({ verification: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: failure ? 'fail' : 'pass', acceptance: input.state.shape!.acceptance.map(({ id }) => ({ id, result: id === failure ? 'fail' : 'pass', reason: id === failure ? 'regression' : 'verified' })) } }),
      )
    }
    const runtime = new FakeRuntime(outcomes)
    await new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)
    const persisted = await new FileStateMutationStore(root).read(state.change_id)
    expect(persisted.budget.repairs_used).toBe(2)
    expect(persisted.verification?.verdict).toBe('pass')
    for (const call of runtime.calls.filter((call) => call.action === 'verify-candidate')) expect(call.state.verification?.acceptance.map((item) => item.result)).toEqual(['pending', 'pending'])
    const failures = []
    for (const entry of persisted.history.filter((entry) => entry.action === 'finish-verification')) failures.push(JSON.parse(await new FileEvidenceStore(root).read(entry.evidence[0])).unresolved_ids)
    expect(failures).toEqual([['A2'], ['A1'], []])
    const captures = persisted.history.filter((entry) => entry.action === 'capture-candidate')
    expect(captures.slice(1).every((entry) => entry.evidence.length === 3)).toBe(true)
    const previous = JSON.parse(await new FileEvidenceStore(root).read(captures[2].evidence[2]))
    expect(previous.candidate_id).not.toBe(persisted.candidate!.candidate_id)
  })
  it('invalidates a candidate modified during review even when the reviewer passes', async () => {
    const { root, state, store, evidence, artifact } = await setup()
    const report = await evidence.write('independent review report')
    const runtime = new FakeRuntime([
      ready({ candidate: { candidate_digest: artifact.sha256, file_manifest: artifact, diff: artifact, summary: 'built', addressed_acceptance_ids: ['A1'], known_limits: [] } }),
      async (input) => {
        await writeFile(join(root, artifact.path), 'external edit')
        return ready({ review: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', report } })
      },
      ready({ kind: 'needs-user', questions: ['Candidate changed; revise implementation?'] }),
    ])
    await new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)
    const persisted = await new FileStateMutationStore(root).read(state.change_id)
    expect(persisted.outer.phase).toBe('build')
    expect(persisted.candidate).toBeNull()
    expect(persisted.verification).toBeNull()
    expect(persisted.outer.stage_visit).toBe(state.outer.stage_visit + 1)
    expect(persisted.history.some((entry) => entry.action === 'candidate-drift')).toBe(true)
  })

  it('returns changed requirements to Shape and invalidates the old approval', async () => {
    const { state, root, store, evidence } = await setup()
    const runtime = new FakeRuntime([
      ready({ kind: 'continue', proposal: { reason: 'acceptance changed', affected_acceptance_ids: ['A1'], suggested_change: 'clarify scope' } }),
      ready({ kind: 'needs-user', questions: ['Confirm the new scope?'] }),
    ])
    await new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)
    const persisted = await new FileStateMutationStore(root).read(state.change_id)
    expect(persisted.outer.phase).toBe('shape')
    expect(persisted.shape).toBeNull()
    expect(persisted.brief.confirmed).toBeNull()
    expect(persisted.skills[0].status).not.toBe('completed')
  })
  it('publishes Shape and requires an explicit approval of its digest before Build', async () => {
    const { state, root, store, evidence, artifact } = await setup('initial')
    const runtime = new FakeRuntime([ready(), ready({ shape: { documents: [artifact], acceptance: [{ id: 'A1', text: 'preserve input', verification: 'check records' }], checks: [] } })])
    await new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)
    const awaiting = await new FileStateMutationStore(root).read(state.change_id)
    expect(awaiting.interaction?.kind).toBe('shape-approval')
    const request = { expectedVersion: awaiting.state_version, actionId: 'confirm-shape', action: 'confirm-shape', payload: { subject_digest: '0'.repeat(64), actor: 'user' } }
    await expect(store.mutate(state.change_id, request)).rejects.toThrow('STALE_RESULT')
    expect((await store.read(state.change_id)).state_version).toBe(awaiting.state_version)
    await store.mutate(state.change_id, { ...request, payload: { ...request.payload, subject_digest: awaiting.shape!.digest } })
    const build = await new FileStateMutationStore(root).read(state.change_id)
    expect(build.outer.phase).toBe('build')
    expect(build.brief.digest).toBe(state.brief.digest)
    expect(build.shape?.approval?.subject_digest).toBe(awaiting.shape!.digest)
  })

  it.each(['stale-review', 'missing-acceptance', 'nonzero-pass'])('rejects %s before delivery advances', async (fault) => {
    const { state, root, store, evidence, artifact } = await setup()
    const runtime = new FakeRuntime([
      ready({ candidate: { candidate_digest: artifact.sha256, file_manifest: artifact, diff: artifact, summary: 'built', addressed_acceptance_ids: ['A1'], known_limits: [] } }),
      (input) => ready({ review: { candidate_id: fault === 'stale-review' ? 'old-candidate' : input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', report: artifact } }),
      ready(),
      (input) => ready({ checks: input.state.shape!.checks.map(({ id }) => ({ id, result: 'pass', exit_code: fault === 'nonzero-pass' ? 1 : 0, report: artifact })) }),
      (input) => ready({ verification: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', acceptance: [] } }),
    ])
    await expect(new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)).rejects.toThrow(fault === 'stale-review' ? 'STALE_RESULT' : fault === 'nonzero-pass' ? 'consistent exit status' : 'frozen acceptance')
    const persisted = await new FileStateMutationStore(root).read(state.change_id)
    expect(persisted.inner.state).toBe('evaluating')
    expect(persisted.verification?.verdict).not.toBe('pass')
    expect(persisted.history.some((entry) => entry.action === 'finish-verification')).toBe(false)
  })
  it('retries a Skill and hands its full output to the next Skill after a restart', async () => {
    const { root, state, evidence, artifact } = await setup('initial')
    const skills = new FileSkillResolver({ roots: ['fixtures/codex-skills'] })
    state.workflow = await createWorkflowSnapshot({ version: 1, name: 'm2-test', workflow: 'phixlin-flow-v1', runtime: 'codex', stages: { shape: { skills: ['outline', 'summarize'] }, build: { skills: [] }, verify: { skills: [] } } }, (name) => skills.resolve(name))
    state.stage_context.binding.workflow_digest = state.workflow.digest
    state.skills = state.workflow.stages.shape.map((snapshot, index) => ({ ...structuredClone(state.skills[0]), name: snapshot.name, index, invocation_id: `shape-visit-1-skill-${index}`, source_digest: snapshot.digest }))
    await writeFile(join(root, state.change_id, 'flow-state.yaml'), stringify(state))
    const store = new FileStateMutationStore(root)
    const runtime = new FakeRuntime([
      ready({ kind: 'blocked', summary: 'temporary failure' }),
      ready({ summary: '# Requirements\n\n- A1: preserve all input records.', skill_invocations: [{ name: 'optional', observation: 'model-reported', status: 'failed', artifact }] }),
      ready({ summary: '{"acceptance":["A1"]}' }),
      ready({ summary: 'shape complete' }),
    ])
    // Stop after the first completed Skill was committed; the next process must not repeat it.
    const stopStore = {
      read: (id: string) => store.read(id),
      async mutate(id: string, request: Parameters<typeof store.mutate>[1]) {
        const receipt = await store.mutate(id, request)
        if (request.action === 'skill-completed') throw new Error('simulated process exit')
        return receipt
      },
    }
    await expect(new StageRunner(stopStore, runtime, { evidence, skills }).drive(state.change_id)).rejects.toThrow('simulated process exit')
    const remaining = new FakeRuntime([ready({ summary: '{"acceptance":["A1"]}' }), ready()])
    await new StageRunner(new FileStateMutationStore(root), remaining, { evidence: new FileEvidenceStore(root), skills }).drive(state.change_id)
    const persisted = await new FileStateMutationStore(root).read(state.change_id)
    expect(persisted.skills[0].attempts).toBe(2)
    expect(persisted.skills[0].status).toBe('completed')
    expect(persisted.skills.find((skill) => skill.name === 'optional')?.status).toBe('failed')
    expect(remaining.calls.map((call) => call.skillName)).toEqual(['summarize', undefined])
    const input = JSON.parse(remaining.calls[0].skillInput!)
    expect(input.predecessor_output).toContain('A1: preserve all input records.')
    expect(input.instructions.map((item: { name: string }) => item.name)).toEqual(['outline', 'summarize'])
    expect(remaining.calls[0].state.stage_context.binding.input_digest).toBe(digestJson(remaining.calls[0].skillInput))
    expect(persisted.history.filter((entry) => entry.action === 'execution-error')).toHaveLength(1)
  })

  it('collects a persisted result after process restart without dispatching again', async () => {
    const { root, state, store, evidence } = await setup()
    const runtime = new FakeRuntime([ready()])
    const stopStore = {
      read: (id: string) => store.read(id),
      async mutate(id: string, request: Parameters<typeof store.mutate>[1]) {
        const receipt = await store.mutate(id, request)
        if (request.action === 'execution-result') throw new Error('process exit after collect')
        return receipt
      },
    }
    await expect(new StageRunner(stopStore, runtime, { evidence, skills }).drive(state.change_id)).rejects.toThrow('process exit after collect')
    const restartedRuntime = new FakeRuntime()
    await new StageRunner(new FileStateMutationStore(root), restartedRuntime, { evidence: new FileEvidenceStore(root), skills }).drive(state.change_id)
    expect(restartedRuntime.calls).toEqual([])
    expect((await store.read(state.change_id)).inner.state).toBe('stage-ready')
  })
  it.each([false, true])('runs independent review and full verification (failed checks: %s)', async (failChecks) => {
    const { root, state, store, evidence, artifact } = await setup()
    const outcomes: (RuntimeResult | ((input: RuntimeInput) => RuntimeResult))[] = []
    const rounds = failChecks ? 4 : 1
    for (let round = 0; round < rounds; round++) {
      outcomes.push(
        ready({ candidate: { candidate_digest: artifact.sha256, file_manifest: artifact, diff: artifact, summary: 'built', addressed_acceptance_ids: ['A1'], known_limits: [] } }),
        (input) => ready({ review: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', report: artifact } }),
        ready(),
        (input) => ready({ checks: input.state.shape!.checks.map(({ id }) => ({ id, result: failChecks ? 'fail' : 'pass', exit_code: failChecks ? 1 : 0, report: artifact })) }),
        (input) => ready({ verification: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', acceptance: input.state.shape!.acceptance.map(({ id }) => ({ id, result: 'pass', reason: 'verified' })) } }),
      )
    }
    const runtime = new FakeRuntime(outcomes)
    await new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)
    const persisted = parseChangeStateYaml(await readFile(join(root, state.change_id, 'flow-state.yaml'), 'utf8'))
    expect(persisted.outer.status).toBe('await-user')
    expect(persisted.verification?.verdict).toBe(failChecks ? 'fail' : 'pass')
    expect(persisted.budget.repairs_used).toBe(failChecks ? 3 : 0)
    expect(persisted.interaction?.kind).toBe(failChecks ? 'budget' : 'result-approval')
    expect(runtime.calls.filter((call) => call.action === 'skill')).toHaveLength(rounds)
    expect(new Set(runtime.calls.map((call) => call.executionRef)).size).toBe(runtime.calls.length)
    const restarted = new StageRunner(new FileStateMutationStore(root), new FakeRuntime(), { evidence: new FileEvidenceStore(root), skills })
    expect((await restarted.drive(state.change_id)).decision.kind).toBe('wait')
  })

  it('requires the current result interaction, then archives and completes without another Agent call', async () => {
    const { state, store, evidence, artifact } = await setup()
    const runtime = new FakeRuntime([
      ready({ candidate: { candidate_digest: artifact.sha256, file_manifest: artifact, diff: artifact, summary: 'built', addressed_acceptance_ids: ['A1'], known_limits: [] } }),
      (input) => ready({ review: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', report: artifact } }),
      ready(),
      (input) => ready({ checks: input.state.shape!.checks.map(({ id }) => ({ id, result: 'pass', exit_code: 0, report: artifact })) }),
      (input) => ready({ verification: { candidate_id: input.state.candidate!.candidate_id, candidate_digest: artifact.sha256, verdict: 'pass', acceptance: input.state.shape!.acceptance.map(({ id }) => ({ id, result: 'pass', reason: 'verified' })) } }),
    ])
    await new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)
    const awaiting = await store.read(state.change_id)
    await expect(store.mutate(state.change_id, { expectedVersion: awaiting.state_version, actionId: 'wrong', action: 'accept-result', payload: { candidate_id: 'old', candidate_digest: artifact.sha256, actor: 'user' } })).rejects.toThrow('result is not awaiting approval, current, and passing')
    await store.mutate(state.change_id, { expectedVersion: awaiting.state_version, actionId: 'accept', action: 'accept-result', payload: { candidate_id: awaiting.candidate!.candidate_id, candidate_digest: awaiting.candidate!.candidate_digest, actor: 'user' } })
    const originalWriteNamed = evidence.writeNamed.bind(evidence)
    let failOnce = true
    evidence.writeNamed = async (...args: Parameters<FileEvidenceStore['writeNamed']>) => {
      if (failOnce) { failOnce = false; throw new Error('simulated archive write failure') }
      return originalWriteNamed(...args)
    }
    await expect(new StageRunner(store, new FakeRuntime(), { evidence, skills }).drive(state.change_id)).rejects.toThrow('simulated archive write failure')
    expect((await store.read(state.change_id)).inner.state).toBe('stage-ready')
    evidence.writeNamed = originalWriteNamed
    const finalRuntime = new FakeRuntime()
    const completed = await new StageRunner(store, finalRuntime, { evidence, skills }).drive(state.change_id)
    expect(completed.state.outer).toMatchObject({ phase: 'completed', status: 'done' })
    expect(finalRuntime.calls).toHaveLength(0)
    const archive = completed.state.finalization.state === 'completed' ? completed.state.finalization.artifacts[0] : undefined
    expect(JSON.parse(await evidence.read(archive!)).schema).toBe('phixlin.archive.v1')
  })

  it('returns a rejected candidate only to Build or Shape and records the comment', async () => {
    const { state, store } = await setup('verify')
    const request = { expectedVersion: state.state_version, actionId: 'changes', action: 'request-changes', payload: { candidate_id: state.candidate!.candidate_id, candidate_digest: state.candidate!.candidate_digest, comment_artifact: state.candidate!.diff, requirements_changed: false } }
    await store.mutate(state.change_id, request)
    const build = await store.read(state.change_id)
    expect(build.outer.phase).toBe('build')
    expect(build.candidate).toBeNull()
    expect(build.history.at(-1)?.payload_digest).toBe(digestJson(request.payload))
  })

  it('returns requirement changes to Shape and invalidates the old specification approval', async () => {
    const { state, store } = await setup('verify')
    await store.mutate(state.change_id, { expectedVersion: state.state_version, actionId: 'requirements', action: 'request-changes', payload: { candidate_id: state.candidate!.candidate_id, candidate_digest: state.candidate!.candidate_digest, comment_artifact: state.candidate!.diff, requirements_changed: true } })
    const shape = await store.read(state.change_id)
    expect(shape.outer.phase).toBe('shape')
    expect(shape.shape).toBeNull()
    expect(shape.brief.confirmed).toBeNull()
    expect(shape.history.at(-1)?.evidence).toEqual([state.candidate!.diff])
  })

  it('does not commit candidate completion when an artifact was corrupted', async () => {
    const { root, state, store, evidence, artifact } = await setup()
    await writeFile(join(root, artifact.path), 'corrupted')
    const runtime = new FakeRuntime([ready({ artifacts: [artifact] })])
    await expect(new StageRunner(store, runtime, { evidence, skills }).drive(state.change_id)).rejects.toThrow('RESOURCE_DRIFT')
    expect((await new FileStateMutationStore(root).read(state.change_id)).inner.state).toBe('executing')
  })
})
