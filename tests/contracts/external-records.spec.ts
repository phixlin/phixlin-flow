import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import {
  ContractError,
  validateDiagnosticEvent,
  validateExecutionResult,
  validateShapeContent,
  validateReducerVectors,
} from '../../src/index.js'

const digest = 'a'.repeat(64)

describe('external record contracts', () => {
  it('Shape 验收项和检查项与状态契约一致，拒绝空项、重复标识和无效检查', () => {
    expect(() => validateShapeContent({ acceptance: [], checks: [] })).toThrow('/shape/acceptance')
    expect(() => validateShapeContent({ acceptance: [{ id: 'A1', text: '', verification: '检查' }], checks: [] })).toThrow('/shape/acceptance/0/text')
    expect(() => validateShapeContent({ acceptance: [{ id: 'A1', text: '完成', verification: '检查' }], checks: [{ id: 'check', argv: [], cwd: '.', timeout_ms: 1 }] })).toThrow('/shape/checks/0/argv')
    expect(() => validateShapeContent({ acceptance: [{ id: 'A1', text: '完成', verification: '检查' }, { id: 'A1', text: '重复', verification: '检查' }], checks: [] })).toThrow('标识不能重复')
    expect(() => validateShapeContent({ acceptance: [{ id: 'A1', text: '完成', verification: '检查' }], checks: [] })).not.toThrow()
  })
  it('accepts a bound needs-user execution result', () => {
    expect(() =>
      validateExecutionResult({
        schema: 'phixlin.execution-result.v1',
        binding: { change_id: 'example', stage_visit: 1, input_digest: digest },
        kind: 'needs-user',
        summary: 'One product choice remains open.',
        artifacts: [],
        questions: ['Should the command overwrite an existing export?'],
        proposal: null,
        skill_invocations: [],
      }),
    ).not.toThrow()
  })

  it('does not let an Agent result carry an approval field', () => {
    expect(() =>
      validateExecutionResult({
        schema: 'phixlin.execution-result.v1',
        binding: { change_id: 'example', stage_visit: 1, input_digest: digest },
        kind: 'stage-ready',
        summary: 'Ready for approval.',
        artifacts: [],
        questions: [],
        proposal: null,
        skill_invocations: [],
        approved: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_EXECUTION_RESULT' }),
    )
  })

  it('rejects questions on a non-interactive result', () => {
    expect(() =>
      validateExecutionResult({
        schema: 'phixlin.execution-result.v1',
        binding: { change_id: 'example', stage_visit: 1, input_digest: digest },
        kind: 'stage-ready',
        summary: 'Ready.',
        artifacts: [],
        questions: ['This must not be ignored.'],
        proposal: null,
        skill_invocations: [],
      }),
    ).toThrowError('stage-ready result cannot contain questions')
  })

  it('requires a question for needs-user', () => {
    expect(() =>
      validateExecutionResult({
        schema: 'phixlin.execution-result.v1',
        binding: { change_id: 'example', stage_visit: 1, input_digest: digest },
        kind: 'needs-user',
        summary: 'Question was lost.',
        artifacts: [],
        questions: [],
        proposal: null,
        skill_invocations: [],
      }),
    ).toThrowError('needs-user result requires at least one question')
  })

  it('rejects duplicate affected acceptance IDs in a proposal', () => {
    expect(() =>
      validateExecutionResult({
        schema: 'phixlin.execution-result.v1',
        binding: { change_id: 'example', stage_visit: 1, input_digest: digest },
        kind: 'continue',
        summary: 'Acceptance needs revision.',
        artifacts: [],
        questions: [],
        proposal: {
          reason: 'The expected behavior is ambiguous.',
          affected_acceptance_ids: ['A1', 'A1'],
          suggested_change: 'Clarify A1.',
        },
        skill_invocations: [],
      }),
    ).toThrowError('proposal contains duplicate acceptance ids')
  })

  it('reports invalid event and reducer vector boundaries distinctly', () => {
    expect(() => validateDiagnosticEvent(null)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_EVENT' }),
    )
    expect(() => validateReducerVectors(null)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_REDUCER_VECTORS' }),
    )
  })

  it('rejects artifact traversal in Agent results and diagnostic events', () => {
    expect(() =>
      validateExecutionResult({
        schema: 'phixlin.execution-result.v1',
        binding: { change_id: 'example', stage_visit: 1, input_digest: digest },
        kind: 'stage-ready',
        summary: 'Unsafe artifact.',
        artifacts: [{ path: 'artifacts/../flow-state.yaml', sha256: digest, bytes: 1 }],
        questions: [],
        proposal: null,
        skill_invocations: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_EXECUTION_RESULT' }),
    )

    expect(() =>
      validateDiagnosticEvent({
        schema: 'phixlin.event.v1',
        event_id: 'event-1',
        sequence: 1,
        at: '2026-09-11T08:00:00Z',
        change_id: 'example',
        state_version: 1,
        kind: 'error',
        operation_id: null,
        execution_ref: null,
        payload_digest: digest,
        artifact: { path: 'artifacts/..\\flow-state.yaml', sha256: digest, bytes: 1 },
      }),
    ).toThrowError(expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_EVENT' }))
  })

  it('accepts a diagnostic event that references immutable evidence', () => {
    expect(() =>
      validateDiagnosticEvent({
        schema: 'phixlin.event.v1',
        event_id: 'event-1',
        sequence: 1,
        at: '2026-09-11T08:00:00Z',
        change_id: 'example',
        state_version: 1,
        kind: 'operation-result-collected',
        operation_id: 'operation-1',
        execution_ref: 'execution-1',
        payload_digest: digest,
        artifact: { path: 'artifacts/result.json', sha256: digest, bytes: 42 },
      }),
    ).not.toThrow()
  })

  it('keeps the M1 reducer vectors machine-readable', () => {
    const vectors = parse(readFileSync('fixtures/reducer/v1.yaml', 'utf8')) as unknown
    expect(() => validateReducerVectors(vectors)).not.toThrow()
  })

  it('validates the checked-in real Codex structured result', () => {
    const result = JSON.parse(readFileSync('docs/evidence/m0/codex-result.json', 'utf8')) as unknown
    expect(() => validateExecutionResult(result)).not.toThrow()
  })
})
