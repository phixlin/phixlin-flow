import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseChangeStateYaml, reduce, ContractError, decide, FakeRuntime, type Action, type ChangeState } from '../../src/index.js'

const load = (name: string): ChangeState => parseChangeStateYaml(readFileSync(`fixtures/state/${name}.yaml`, 'utf8'))
const artifact = (name: string) => ({ path: `artifacts/${name}`, sha256: 'a'.repeat(64), bytes: 1 })

function collect(state: ChangeState, action: Action, operationId: string, executionRef: string) {
  if ('position' in state.inner) state.inner.position.action = action
  const reserved = reduce(state, { type: 'reserve-operation', payload: { operation_id: operationId, execution_ref: executionRef } })
  return reduce(reserved, { type: 'execution-result', payload: { operation_id: operationId, result: artifact(`${operationId}.json`) } })
}

describe('root reducer M1 vectors', () => {
  it('reserves and collects one operation with a monotonic version', () => {
    const reserved = reduce(load('initial'), { type: 'reserve-operation', actionId: 'reserve-1', payload: { operation_id: 'op-1', execution_ref: 'exec-1' } })
    expect(reserved.state_version).toBe(1)
    expect(reserved.inner.state).toBe('executing')
    const collected = reduce(reserved, { type: 'execution-result', actionId: 'collect-1', payload: { operation_id: 'op-1', result: artifact('result.json') } })
    expect(collected.inner.state).toBe('evaluating')
  })

  it('rejects a stale external result without mutating the input', () => {
    const state = load('build')
    expect(() => reduce(state, { type: 'execution-result', payload: { operation_id: 'old', result: artifact('stale.json') } })).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_ACTION' }),
    )
    expect(state.state_version).toBe(1)
  })

  it('enters blocked after the configured execution failure limit', () => {
    const reserved = reduce(load('initial'), { type: 'reserve-operation', payload: { operation_id: 'op-1', execution_ref: 'exec-1' } })
    reserved.budget.execution_failures = 2
    const blocked = reduce(reserved, { type: 'execution-error', payload: { operation_id: 'op-1', confirmed_stopped: true } })
    expect(blocked.outer.status).toBe('blocked')
    expect(blocked.inner.state).toBe('blocked')
  })

  it('暂停并恢复可恢复状态', () => {
    const paused = reduce(load('initial'), { type: 'pause', payload: {} })
    expect(paused.outer.status).toBe('paused')
    const resumed = reduce(paused, { type: 'resume-state', payload: {} })
    expect(resumed.outer.status).toBe('active')
  })

  it('拒绝错误状态下的暂停和恢复', () => {
    const state = load('initial')
    state.outer.status = 'blocked'
    state.inner = { state: 'blocked', position: { action: 'skill', skill_index: 0, turn: 0, attempt: 0 }, blocker_id: 'b' }
    state.blocker = { id: 'b', code: 'EXECUTION_FAILED', reason: 'failed', allowed_actions: ['inspect'], resume: { state: 'ready', position: { action: 'skill', skill_index: 0, turn: 0, attempt: 0 } } }
    expect(() => reduce(state, { type: 'pause', payload: {} })).toThrow('pause requires')
    expect(() => reduce(load('initial'), { type: 'resume-state', payload: {} })).toThrow('resume requires')
  })

  it('协调丢失执行并在失败预算内重试', () => {
    const reserved = reduce(load('initial'), { type: 'reserve-operation', payload: { operation_id: 'op-1', execution_ref: 'exec-1' } })
    const reconciling = reduce(reserved, { type: 'execution-lost', payload: { operation_id: 'op-1' } })
    expect(reconciling.inner.state).toBe('reconciling')

    const retryable = reduce(reserved, { type: 'execution-error', payload: { operation_id: 'op-1', confirmed_stopped: true } })
    expect(retryable.inner.state).toBe('ready')
    expect(retryable.skills[0]?.status).toBe('failed')
    expect(() => reduce(reserved, { type: 'execution-error', payload: { operation_id: 'op-1', confirmed_stopped: false } })).toThrow('confirmed stopped')
  })

  it('从可重试 blocker 恢复并拒绝不可重试 blocker', () => {
    const reserved = reduce(load('initial'), { type: 'reserve-operation', payload: { operation_id: 'op-1', execution_ref: 'exec-1' } })
    reserved.budget.execution_failures = 2
    const blocked = reduce(reserved, { type: 'execution-error', payload: { operation_id: 'op-1', confirmed_stopped: true, blocker_id: 'b' } })
    const retried = reduce(blocked, { type: 'retry-blocker', payload: {} })
    expect(retried).toMatchObject({ outer: { status: 'active' }, blocker: null, budget: { execution_failures: 0 } })
    blocked.blocker!.allowed_actions = ['inspect']
    expect(() => reduce(blocked, { type: 'retry-blocker', payload: {} })).toThrow('retryable blocker')
  })

  it('记录上下文 Skill 并继续当前动作', () => {
    const reserved = reduce(load('initial'), { type: 'reserve-operation', payload: { operation_id: 'op-1', execution_ref: 'exec-1' } })
    const collected = reduce(reserved, { type: 'execution-result', payload: { operation_id: 'op-1', result: artifact('result.json') } })
    const observed = reduce(collected, { type: 'contextual-skill-observed', payload: { operation_id: 'op-1', invocation_id: 'ctx-1', name: 'context', observation: 'model-reported', status: 'completed', artifacts: [] } })
    expect(observed.skills.at(-1)).toMatchObject({ mode: 'contextual', name: 'context', completed_by: 'exec-1' })
    const continued = reduce(observed, { type: 'result-continue', payload: { operation_id: 'op-1' } })
    expect(continued.inner.state).toBe('ready')
    expect(continued.skills[0]?.status).toBe('failed')
    expect(() => reduce(observed, { type: 'result-continue', payload: { operation_id: 'op-1', verdict: 'pass' } })).toThrow('verification verdicts')
  })

  it('持久化用户回答后恢复原动作', () => {
    const state = load('initial')
    const waiting = reduce(state, { type: 'result-needs-user', payload: { interaction_id: 'q1', questions: ['继续？'] } })
    expect(waiting.outer.status).toBe('await-user')
    expect(() => reduce(waiting, { type: 'user-answer', payload: { interaction_id: 'other' } })).toThrow('interaction does not match')
    expect(() => reduce(waiting, { type: 'user-answer', payload: { interaction_id: 'q1' } })).toThrow('persisted artifact')
    const artifact = { path: 'artifacts/answer.md', sha256: 'a'.repeat(64), bytes: 3 }
    const answered = reduce(waiting, { type: 'user-answer', payload: { interaction_id: 'q1', answer_artifact: artifact } })
    expect(answered).toMatchObject({ outer: { status: 'active' }, interaction: null, inner: { state: 'ready' } })
    expect(answered.stage_context.stage_artifacts).toContainEqual(artifact)
  })

  it('重置 brief、候选漂移和用户退回后的阶段', () => {
    const changed = reduce(load('build'), { type: 'brief-change-proposed', payload: {} })
    expect(changed).toMatchObject({ outer: { phase: 'shape', status: 'active' }, candidate: null, shape: null })

    const verify = load('verify')
    const drifted = reduce(verify, { type: 'candidate-drift', payload: {} })
    expect(drifted).toMatchObject({ outer: { phase: 'build', status: 'active' }, candidate: null, verification: null })

    const comment = { path: 'artifacts/comment.md', sha256: 'b'.repeat(64), bytes: 4 }
    const requested = reduce(verify, { type: 'request-changes', payload: { candidate_id: verify.candidate!.candidate_id, candidate_digest: verify.candidate!.candidate_digest, comment_artifact: comment, requirements_changed: true } })
    expect(requested).toMatchObject({ outer: { phase: 'shape' }, shape: null, candidate: null })
  })

  it('拒绝未知事件、过期 operation 和耗尽的 turn 预算', () => {
    expect(() => reduce(load('initial'), { type: 'unknown', payload: {} })).toThrow('unknown reducer event')
    const state = load('initial')
    state.budget.turns_used = state.budget.turn_limit
    expect(() => reduce(state, { type: 'reserve-operation', payload: { operation_id: 'op', execution_ref: 'exec' } })).toThrow('turn budget exhausted')
    const reserved = reduce(load('initial'), { type: 'reserve-operation', payload: { operation_id: 'op', execution_ref: 'exec' } })
    expect(() => reduce(reserved, { type: 'execution-result', payload: { operation_id: 'stale', result: artifact('result.json') } })).toThrowError(expect.objectContaining({ code: 'STALE_RESULT' }))
  })

  it('直接完成候选采集、失败复审和通过复审', () => {
    const evaluated = collect(load('build'), 'agent-work', 'build-op', 'builder')
    const handoff = {
      operation_id: 'build-op', candidate_id: 'candidate-direct', candidate_digest: 'c'.repeat(64),
      file_manifest: artifact('manifest.json'), diff: artifact('diff.json'), builder_execution_ref: 'builder', summary: 'built',
    }
    expect(() => reduce(evaluated, { type: 'capture-candidate', payload: { ...handoff, candidate_id: '' } })).toThrow('handoff is incomplete')
    expect(() => reduce(evaluated, { type: 'capture-candidate', payload: { ...handoff, builder_execution_ref: 'other' } })).toThrow('candidate capture requires')
    const captured = reduce(evaluated, { type: 'capture-candidate', payload: handoff })
    expect(captured.candidate?.summary).toBe('built')

    const failedReviewState = collect(structuredClone(captured), 'review-candidate', 'review-op', 'reviewer')
    const reviewPayload = { operation_id: 'review-op', execution_ref: 'reviewer', candidate_id: 'candidate-direct', candidate_digest: 'c'.repeat(64), verdict: 'fail', report: artifact('review.json') }
    expect(() => reduce(failedReviewState, { type: 'review-candidate', payload: { ...reviewPayload, candidate_id: 'old' } })).toThrowError(expect.objectContaining({ code: 'STALE_RESULT' }))
    const failed = reduce(failedReviewState, { type: 'review-candidate', payload: reviewPayload })
    expect(failed.inner).toMatchObject({ state: 'ready', position: { action: 'agent-work' } })

    const passedReviewState = collect(structuredClone(captured), 'review-candidate', 'review-pass-op', 'reviewer-pass')
    const passed = reduce(passedReviewState, { type: 'review-candidate', payload: { ...reviewPayload, operation_id: 'review-pass-op', execution_ref: 'reviewer-pass', verdict: 'pass' } })
    expect(passed.inner.state).toBe('stage-ready')
    const verifying = reduce(passed, { type: 'stage-transition', payload: {} })
    expect(verifying.outer.phase).toBe('verify')
  })

  it('拒绝无 operation 或无 position 的外部结果', () => {
    expect(() => reduce(load('initial'), { type: 'execution-result', payload: { operation_id: 'none', result: artifact('result.json') } })).toThrow('no operation')
    const done = load('completed')
    expect(() => reduce(done, { type: 'execution-result', payload: { operation_id: 'none', result: artifact('result.json') } })).toThrow('no operation')
  })

  it.each(['idle', 'waiting-user', 'blocked'] as const)('拒绝 active/%s 这种已被校验器排除的组合', (innerState) => {
    const state = load('initial')
    state.inner = { state: innerState } as ChangeState['inner']
    expect(() => decide(state)).toThrow(`validated active state cannot have inner state ${innerState}`)
  })

  it('FakeRuntime 在没有预设结果时大声失败', async () => {
    const state = load('initial')
    await expect(new FakeRuntime().execute({ operationId: 'op', executionRef: 'exec', state, action: 'skill' })).rejects.toThrow('no outcome for skill')
  })

  it('直接执行宿主检查和独立验证并拒绝伪造结果', () => {
    const build = load('build')
    build.workflow.stages.verify = []
    const evaluated = collect(build, 'agent-work', 'build-verify-op', 'builder-verify')
    const captured = reduce(evaluated, { type: 'capture-candidate', payload: {
      operation_id: 'build-verify-op', candidate_id: 'candidate-verify', candidate_digest: 'c'.repeat(64),
      file_manifest: artifact('verify-manifest.json'), diff: artifact('verify-diff.json'), builder_execution_ref: 'builder-verify', summary: 'built',
    } })
    const reviewState = collect(captured, 'review-candidate', 'review-verify-op', 'reviewer-verify')
    const reviewed = reduce(reviewState, { type: 'review-candidate', payload: {
      operation_id: 'review-verify-op', execution_ref: 'reviewer-verify', candidate_id: 'candidate-verify', candidate_digest: 'c'.repeat(64), verdict: 'pass', report: artifact('verify-review.json'),
    } })
    const verify = reduce(reviewed, { type: 'stage-transition', payload: {} })
    const checksState = collect(verify, 'run-checks', 'checks-op', 'checks-exec')
    const check = { id: verify.shape!.checks[0]!.id, result: 'pass', exit_code: 0, report: artifact('check.json') }
    const checkPayload = { operation_id: 'checks-op', candidate_id: 'candidate-verify', candidate_digest: 'c'.repeat(64), checks: [check] }
    expect(() => reduce(checksState, { type: 'run-checks', payload: { ...checkPayload, candidate_digest: 'd'.repeat(64) } })).toThrowError(expect.objectContaining({ code: 'STALE_RESULT' }))
    expect(() => reduce(checksState, { type: 'run-checks', payload: { ...checkPayload, checks: [{ ...check, exit_code: 1 }] } })).toThrowError(expect.objectContaining({ code: 'INVALID_EXECUTION_RESULT' }))
    const checked = reduce(checksState, { type: 'run-checks', payload: checkPayload })

    const verifierState = collect(checked, 'verify-candidate', 'verifier-op', 'verifier')
    const verificationPayload = { operation_id: 'verifier-op', execution_ref: 'verifier', candidate_id: 'candidate-verify', candidate_digest: 'c'.repeat(64), verdict: 'pass', acceptance: verify.shape!.acceptance.map(({ id }) => ({ id, result: 'pass', reason: 'verified' })), evidence: [artifact('verification.json')] }
    const builderVerifierState = collect(structuredClone(checked), 'verify-candidate', 'builder-verifier-op', 'builder-verify')
    expect(() => reduce(builderVerifierState, { type: 'verify-candidate', payload: { ...verificationPayload, operation_id: 'builder-verifier-op', execution_ref: 'builder-verify' } })).toThrow('verifier must be independent')
    expect(() => reduce(verifierState, { type: 'verify-candidate', payload: { ...verificationPayload, checks: [] } })).toThrow('cannot replace host checks')
    const verified = reduce(verifierState, { type: 'verify-candidate', payload: verificationPayload })
    expect(verified.verification).toMatchObject({ verdict: 'pass', unresolved_ids: [] })
  })
})
