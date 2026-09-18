import type { Action, ChangeState, ArtifactRef, BuilderHandoff, VerificationSnapshot, ShapeSnapshot } from '../contracts/types.js'

export interface RuntimeResult {
  kind: 'continue' | 'needs-user' | 'stage-ready' | 'blocked'
  summary: string
  artifacts: ArtifactRef[]
  questions: string[]
  proposal: null | { reason: string; affected_acceptance_ids: string[]; suggested_change: string }
  raw_output?: ArtifactRef
  shape?: Pick<ShapeSnapshot, 'documents' | 'acceptance' | 'checks'>
  candidate?: Pick<BuilderHandoff, 'candidate_digest' | 'file_manifest' | 'diff' | 'summary' | 'addressed_acceptance_ids' | 'known_limits'>
  review?: { candidate_id: string; candidate_digest: string; verdict: 'pass' | 'fail'; report: ArtifactRef }
  checks?: VerificationSnapshot['checks']
  verification?: { candidate_id: string; candidate_digest: string; verdict: 'pass' | 'fail'; acceptance: VerificationSnapshot['acceptance'] }
  skill_invocations?: { name: string; observation: 'host-observed' | 'model-reported'; status: 'completed' | 'failed'; artifact: ArtifactRef | null }[]
}

export interface RuntimeInput {
  operationId: string
  executionRef: string
  state: ChangeState
  action: Action
  skillName?: string
  skillInput?: string
}

export interface RuntimeAdapter {
  execute(input: RuntimeInput): Promise<RuntimeResult>
  inspectCandidate?(): Promise<string>
}

/** Deterministic runtime used by M1 tests; each queued result is consumed once. */
export class FakeRuntime implements RuntimeAdapter {
  readonly calls: RuntimeInput[] = []
  private readonly outcomes: (RuntimeResult | ((input: RuntimeInput) => RuntimeResult | Promise<RuntimeResult>))[]

  constructor(outcomes: (RuntimeResult | ((input: RuntimeInput) => RuntimeResult | Promise<RuntimeResult>))[] = []) {
    this.outcomes = [...outcomes]
  }

  async execute(input: RuntimeInput): Promise<RuntimeResult> {
    this.calls.push(structuredClone(input))
    const outcome = this.outcomes.shift()
    if (!outcome) throw new Error(`FakeRuntime has no outcome for ${input.action}`)
    const result = typeof outcome === 'function' ? await outcome(input) : outcome
    return structuredClone(result)
  }
}
