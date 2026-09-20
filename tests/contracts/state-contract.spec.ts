import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ContractError,
  decide,
  parseChangeStateYaml,
  validateChangeState,
  type ChangeState,
} from '../../src/index.js'

function fixture(name: string): ChangeState {
  return parseChangeStateYaml(readFileSync(`fixtures/state/${name}.yaml`, 'utf8'))
}

function expectInvalid(mutator: (state: ChangeState) => void, message: string): void {
  const state = structuredClone(fixture('verify'))
  mutator(state)
  expect(() => validateChangeState(state)).toThrowError(
    expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_STATE', message: expect.stringContaining(message) }),
  )
}

describe('flow state v1 contract', () => {
  it.each([
    ['initial', { kind: 'dispatch', action: 'skill', skill_index: 0 }],
    ['build', { kind: 'dispatch', action: 'agent-work', skill_index: null }],
    ['verify', { kind: 'wait', reason: 'await-user' }],
    ['completed', { kind: 'done' }],
  ] as const)('parses the complete %s fixture and derives its next command', (name, expected) => {
    expect(decide(fixture(name))).toEqual(expected)
  })

  it('rejects an unknown phase at the schema boundary', () => {
    const state = structuredClone(fixture('initial')) as unknown as {
      outer: { phase: string }
    }
    state.outer.phase = 'archive'
    expect(() => validateChangeState(state)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_STATE' }),
    )
  })

  it.each([
    'C:\\workspace\\example',
    '\\\\server\\share\\example',
  ])('接受跨平台绝对 workspace root：%s', (root) => {
    const state = structuredClone(fixture('initial'))
    state.workspace.root = root
    expect(() => validateChangeState(state)).not.toThrow()
  })

  it.each([
    'workspace/example',
    'C:workspace\\example',
    '\\workspace\\example',
  ])('拒绝非绝对 workspace root：%s', (root) => {
    expectInvalid((state) => { state.workspace.root = root }, 'workspace/root')
  })

  it('rejects a candidate bound to an old spec revision', () => {
    expectInvalid((state) => {
      if (state.candidate !== null) state.candidate.spec_revision = 2
    }, 'candidate is bound to a stale spec revision')
  })

  it('rejects duplicate planned Skill records', () => {
    expectInvalid((state) => {
      const duplicate = structuredClone(state.skills[0])
      duplicate.invocation_id = 'duplicate-invocation'
      state.skills.push(duplicate)
    }, 'duplicate planned skill index')
  })

  it('rejects incompatible outer and inner states', () => {
    expectInvalid((state) => {
      state.outer.status = 'active'
    }, 'active status cannot combine with inner waiting-user')
  })

  it('rejects artifact references that escape artifacts/', () => {
    expectInvalid((state) => {
      state.workspace.baseline.path = 'artifacts/../flow-state.yaml'
    }, 'artifact path is not normalized')
  })

  it('rejects duplicate YAML keys instead of accepting the last value', () => {
    const yaml = readFileSync('fixtures/state/initial.yaml', 'utf8').replace(
      'schema: phixlin.flow.v1',
      'schema: phixlin.flow.v1\nschema: phixlin.flow.v1',
    )
    expect(() => parseChangeStateYaml(yaml)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_STATE' }),
    )
  })
})
