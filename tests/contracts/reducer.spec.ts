import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseChangeStateYaml, reduce, ContractError, type ChangeState } from '../../src/index.js'

const load = (name: string): ChangeState => parseChangeStateYaml(readFileSync(`fixtures/state/${name}.yaml`, 'utf8'))

describe('root reducer M1 vectors', () => {
  it('reserves and collects one operation with a monotonic version', () => {
    const reserved = reduce(load('initial'), { type: 'reserve-operation', actionId: 'reserve-1', payload: { operation_id: 'op-1', execution_ref: 'exec-1' } })
    expect(reserved.state_version).toBe(1)
    expect(reserved.inner.state).toBe('executing')
    const collected = reduce(reserved, { type: 'execution-result', actionId: 'collect-1', payload: { operation_id: 'op-1', result: 'artifacts/result.json' } })
    expect(collected.inner.state).toBe('evaluating')
  })

  it('rejects a stale external result without mutating the input', () => {
    const state = load('build')
    expect(() => reduce(state, { type: 'execution-result', payload: { operation_id: 'old', result: 'artifacts/stale.json' } })).toThrowError(
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
})
