import { digestJson } from '../contracts/digest.js'
import type { Action, ChangeState, ArtifactRef } from '../contracts/types.js'

export interface RuntimeResult {
  kind: 'continue' | 'needs-user' | 'stage-ready' | 'blocked'
  summary: string
  artifacts: ArtifactRef[]
  questions: string[]
  proposal: null | { reason: string; affected_acceptance_ids: string[]; suggested_change: string }
  raw_output?: ArtifactRef
}

export interface RuntimeInput {
  operationId: string
  executionRef: string
  state: ChangeState
  action: Action
  skillName?: string
}

export interface RuntimeAdapter {
  execute(input: RuntimeInput): Promise<RuntimeResult>
  result?(operationId: string): RuntimeResult | undefined
}

const emptyResult = (kind: RuntimeResult['kind'], summary: string): RuntimeResult => ({
  kind,
  summary,
  artifacts: [],
  questions: [],
  proposal: null,
})

/** Deterministic runtime used by M1 tests; each queued result is consumed once. */
export class FakeRuntime implements RuntimeAdapter {
  readonly calls: RuntimeInput[] = []
  private readonly outcomes: RuntimeResult[]
  private readonly byOperation = new Map<string, RuntimeResult>()

  constructor(outcomes: RuntimeResult[] = []) {
    this.outcomes = [...outcomes]
  }

  enqueue(result: RuntimeResult): void { this.outcomes.push(result) }

  async execute(input: RuntimeInput): Promise<RuntimeResult> {
    this.calls.push(structuredClone(input))
    const result = this.outcomes.shift() ?? emptyResult('continue', `${input.action} completed`)
    const output = result.raw_output ?? {
      path: `artifacts/${input.operationId}-output.json`,
      sha256: digestJson(result),
      bytes: JSON.stringify(result).length,
    }
    const normalized = { ...structuredClone(result), raw_output: output }
    this.byOperation.set(input.operationId, normalized)
    return normalized
  }

  result(operationId: string): RuntimeResult | undefined {
    const value = this.byOperation.get(operationId)
    return value === undefined ? undefined : structuredClone(value)
  }
}
