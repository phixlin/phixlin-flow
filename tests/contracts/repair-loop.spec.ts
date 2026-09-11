import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseChangeStateYaml, reduce, type ChangeState } from '../../src/index.js'

const load = (): ChangeState => parseChangeStateYaml(readFileSync('fixtures/state/verify.yaml', 'utf8'))

describe('Verify repair loop', () => {
  it('returns a failed Verify candidate to Build and increments repair budget', () => {
    const state = load()
    state.outer.status = 'active'
    state.interaction = null
    state.inner = {
      state: 'evaluating',
      position: { action: 'verify-candidate', skill_index: null, turn: 1, attempt: 1 },
      operation: {
        operation_id: 'verify-op',
        execution_ref: 'verify-exec',
        binding: structuredClone(state.stage_context.binding),
        action: 'verify-candidate',
        attempt: 1,
        reserved_at: '2026-09-11T08:40:00Z',
        process: null,
      },
      result: { path: 'artifacts/verify-result.json', sha256: '0'.repeat(64), bytes: 1 },
    }
    const next = reduce(state, {
      type: 'result-continue',
      payload: { operation_id: 'verify-op', verdict: 'fail', unresolved_ids: ['A1'], reason: 'check failed' },
    })
    expect(next.outer.phase).toBe('build')
    expect(next.outer.iteration).toBe(2)
    expect(next.budget.repairs_used).toBe(1)
    expect(next.verification).toBeNull()
  })
})
