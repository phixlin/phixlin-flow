import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ContractError,
  parseChangeStateYaml,
  validateChangeState,
  type ChangeState,
} from '../../src/index.js'

function fixture(name: 'build' | 'verify' | 'completed' = 'verify'): ChangeState {
  return parseChangeStateYaml(readFileSync(`fixtures/state/${name}.yaml`, 'utf8'))
}

function expectIssue(
  name: 'build' | 'verify' | 'completed',
  mutate: (state: ChangeState) => void,
  issue: string,
): void {
  const state = fixture(name)
  mutate(state)
  expect(() => validateChangeState(state)).toThrowError(
    expect.objectContaining<Partial<ContractError>>({
      code: 'INVALID_STATE',
      message: expect.stringContaining(issue),
    }),
  )
}

describe('Shape and candidate bindings', () => {
  it.each([
    ['brief approval', (state: ChangeState) => { if (state.brief.confirmed) state.brief.confirmed.subject_digest = 'a'.repeat(64) }, 'brief approval is bound to a different digest'],
    ['duplicate acceptance', (state: ChangeState) => { if (state.shape) state.shape.acceptance.push(structuredClone(state.shape.acceptance[0])) }, 'shape contains duplicate acceptance ids'],
    ['duplicate check', (state: ChangeState) => { if (state.shape) state.shape.checks.push(structuredClone(state.shape.checks[0])) }, 'shape contains duplicate check ids'],
    ['shape approval', (state: ChangeState) => { if (state.shape?.approval) state.shape.approval.subject_digest = 'a'.repeat(64) }, 'shape approval is bound to a different digest'],
    ['unconfirmed Build', (state: ChangeState) => { state.brief.confirmed = null }, 'build requires confirmed brief and shape'],
  ] as const)('rejects invalid %s', (_case, mutate, issue) => {
    expectIssue('build', mutate, issue)
  })

  it.each([
    ['future iteration', (state: ChangeState) => { if (state.candidate) state.candidate.iteration = 2 }, 'candidate iteration is ahead of outer iteration'],
    ['review digest', (state: ChangeState) => { if (state.candidate?.review) state.candidate.review.candidate_digest = 'a'.repeat(64) }, 'candidate review is bound to a different digest'],
    ['review identity', (state: ChangeState) => { if (state.candidate?.review) state.candidate.review.execution_ref = state.candidate.builder_execution_ref }, 'candidate reviewer must use a different execution_ref'],
    ['unknown acceptance', (state: ChangeState) => { if (state.candidate) state.candidate.addressed_acceptance_ids = ['A2'] }, 'candidate addresses unknown acceptance id A2'],
    ['failed review', (state: ChangeState) => { if (state.candidate?.review) state.candidate.review.verdict = 'fail' }, 'verify requires a reviewed candidate'],
  ] as const)('rejects candidate %s', (_case, mutate, issue) => {
    expectIssue('verify', mutate, issue)
  })
})

describe('Verifier and approval bindings', () => {
  it.each([
    ['stale candidate', (state: ChangeState) => { if (state.verification) state.verification.candidate_id = 'old-candidate' }, 'verification is bound to a stale candidate'],
    ['duplicate acceptance', (state: ChangeState) => { if (state.verification) state.verification.acceptance.push(structuredClone(state.verification.acceptance[0])) }, 'verification contains duplicate acceptance ids'],
    ['missing acceptance', (state: ChangeState) => { if (state.verification) state.verification.acceptance = [] }, 'verification does not cover the frozen acceptance list in order'],
    ['duplicate check', (state: ChangeState) => { if (state.verification) state.verification.checks.push(structuredClone(state.verification.checks[0])) }, 'verification contains duplicate check ids'],
    ['missing check', (state: ChangeState) => { if (state.verification) state.verification.checks = [] }, 'verification does not cover the frozen check list in order'],
    ['builder identity', (state: ChangeState) => { if (state.verification && state.candidate) state.verification.execution_ref = state.candidate.builder_execution_ref }, 'verifier must use an execution_ref distinct'],
    ['reviewer identity', (state: ChangeState) => { if (state.verification && state.candidate?.review) state.verification.execution_ref = state.candidate.review.execution_ref }, 'verifier must use an execution_ref distinct'],
    ['failed check under pass', (state: ChangeState) => { if (state.verification) state.verification.checks[0].result = 'fail' }, 'pass verification requires all checks'],
    ['failed acceptance under pass', (state: ChangeState) => { if (state.verification) state.verification.acceptance[0].result = 'fail' }, 'pass verification requires all checks'],
    ['unresolved item under pass', (state: ChangeState) => { if (state.verification) state.verification.unresolved_ids = ['A1'] }, 'pass verification requires all checks'],
  ] as const)('rejects %s', (_case, mutate, issue) => {
    expectIssue('verify', mutate, issue)
  })

  it('rejects result approval for another candidate digest', () => {
    expectIssue('completed', (state) => {
      if (state.verification?.approval) state.verification.approval.subject_digest = 'a'.repeat(64)
    }, 'result approval is bound to a different candidate digest')
  })

  it.each([
    ['verification verdict', (state: ChangeState) => { if (state.verification) state.verification.verdict = 'blocked' }],
    ['missing approval', (state: ChangeState) => { if (state.verification) state.verification.approval = null }],
    ['pending finalization', (state: ChangeState) => { state.finalization = { state: 'pending' } }],
  ] as const)('rejects completed state with invalid %s', (_case, mutate) => {
    expectIssue(
      'completed',
      mutate,
      'completed phase requires approved pass verification and completed finalization',
    )
  })

  it('rejects finalization for a stale candidate', () => {
    expectIssue('completed', (state) => {
      if (state.finalization.state !== 'pending') state.finalization.candidate_id = 'old-candidate'
    }, 'finalization is bound to a stale candidate')
  })
})

describe('history invariants', () => {
  it('rejects a history length that disagrees with state_version', () => {
    expectIssue('build', (state) => {
      state.state_version = 2
    }, 'history length must equal state_version')
  })

  it('rejects duplicate action IDs', () => {
    expectIssue('verify', (state) => {
      state.history[1].action_id = state.history[0].action_id
    }, 'duplicate history action_id')
  })

  it('rejects a non-contiguous version range', () => {
    expectIssue('verify', (state) => {
      state.history[1].from_version = 0
    }, 'history entry 1 has a non-contiguous version range')
  })

  it('rejects updated_at that does not match the latest mutation', () => {
    expectIssue('verify', (state) => {
      state.updated_at = '2026-09-11T08:31:00Z'
    }, 'updated_at must equal the latest history timestamp')
  })
})
