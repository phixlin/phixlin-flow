export type Phase = 'shape' | 'build' | 'verify' | 'completed'
export type Gate = 'active' | 'await-user' | 'paused' | 'blocked' | 'done'
export type Action =
  | 'skill'
  | 'agent-work'
  | 'capture-candidate'
  | 'review-candidate'
  | 'run-checks'
  | 'verify-candidate'
  | 'finalize'

export interface ArtifactRef {
  path: string
  sha256: string
  bytes: number
}

export interface Binding {
  change_id: string
  stage_visit: number
  workflow_digest: string
  brief_revision: number
  spec_revision: number | null
  candidate_id: string | null
  input_digest: string
}

export interface Operation {
  operation_id: string
  execution_ref: string
  binding: Binding
  action: Action
  attempt: number
  reserved_at: string
  process: { pid: number; started_at: string } | null
}

export interface LoopPosition {
  action: Action
  skill_index: number | null
  turn: number
  attempt: number
}

export type ReadyLifecycle = { state: 'ready'; position: LoopPosition }
export type ReconcilingLifecycle = {
  state: 'reconciling'
  position: LoopPosition
  operation: Operation
}
export type StageReadyLifecycle = {
  state: 'stage-ready'
  position: LoopPosition
  evidence: ArtifactRef[]
}
export type ResumableLifecycle = ReadyLifecycle | ReconcilingLifecycle | StageReadyLifecycle

export type Lifecycle =
  | { state: 'idle' }
  | ReadyLifecycle
  | { state: 'executing'; position: LoopPosition; operation: Operation }
  | ReconcilingLifecycle
  | {
      state: 'evaluating'
      position: LoopPosition
      operation: Operation
      result: ArtifactRef
    }
  | { state: 'waiting-user'; position: LoopPosition; interaction_id: string }
  | { state: 'blocked'; position: LoopPosition; blocker_id: string }
  | StageReadyLifecycle

export interface SkillExecutionRecord {
  invocation_id: string
  mode: 'planned' | 'contextual'
  index: number | null
  name: string
  source_digest: string
  observation: 'host-observed' | 'model-reported'
  status: 'pending' | 'running' | 'completed' | 'failed'
  attempts: number
  input_digest: string | null
  raw_output: ArtifactRef | null
  artifacts: ArtifactRef[]
  workspace_before: string | null
  workspace_after: string | null
  completed_by: string | null
}

export interface SkillResourceSnapshot {
  path: string
  sha256: string
  bytes: number
}

export interface SkillSnapshot {
  name: string
  path: string
  digest: string
  resources: SkillResourceSnapshot[]
  source_commit: string | null
}

export interface WorkflowProfile {
  version: 1
  name: string
  workflow: 'phixlin-flow-v1'
  runtime: 'codex'
  stages: Record<Exclude<Phase, 'completed'>, { skills: string[] }>
}

export interface WorkflowSnapshot {
  name: string
  version: 1
  workflow: 'phixlin-flow-v1'
  runtime: 'codex'
  digest: string
  stages: Record<Exclude<Phase, 'completed'>, SkillSnapshot[]>
}

export interface Approval {
  actor: string
  action_id: string
  subject_digest: string
  at: string
}

export interface Check {
  id: string
  argv: string[]
  cwd: string
  timeout_ms: number
}

export interface ShapeSnapshot {
  spec_revision: number
  digest: string
  documents: ArtifactRef[]
  acceptance: { id: string; text: string; verification: string }[]
  checks: Check[]
  approval: Approval | null
}

export interface BuilderHandoff {
  candidate_id: string
  spec_revision: number
  iteration: number
  candidate_digest: string
  file_manifest: ArtifactRef
  diff: ArtifactRef
  builder_execution_ref: string
  summary: string
  addressed_acceptance_ids: string[]
  known_limits: string[]
  review: {
    execution_ref: string
    candidate_digest: string
    verdict: 'pass' | 'fail'
    report: ArtifactRef
  } | null
}

export interface VerificationSnapshot {
  candidate_id: string
  candidate_digest: string
  spec_revision: number
  attempt: number
  execution_ref: string | null
  checks: {
    id: string
    result: 'pending' | 'pass' | 'fail' | 'error'
    exit_code: number | null
    report: ArtifactRef | null
  }[]
  acceptance: {
    id: string
    result: 'pending' | 'pass' | 'fail'
    reason: string
  }[]
  verdict: 'pending' | 'pass' | 'fail' | 'blocked'
  unresolved_ids: string[]
  approval: Approval | null
}

export interface Interaction {
  id: string
  kind: 'question' | 'shape-approval' | 'result-approval' | 'budget'
  binding: Binding
  questions: string[]
  answers: string[]
  resume: ResumableLifecycle
}

export interface Blocker {
  id: string
  code: string
  reason: string
  allowed_actions: string[]
  resume: ResumableLifecycle
}

export type Finalization =
  | { state: 'pending' }
  | {
      state: 'prepared' | 'completed'
      candidate_id: string
      candidate_digest: string
      artifacts: ArtifactRef[]
    }

export interface TransitionRecord {
  action_id: string
  payload_digest: string
  action: string
  from_version: number
  to_version: number
  at: string
  before: { phase: Phase; status: Gate; inner_state: Lifecycle['state'] }
  after: { phase: Phase; status: Gate; inner_state: Lifecycle['state'] }
  evidence: ArtifactRef[]
}

export interface ChangeState {
  schema: 'phixlin.flow.v1'
  change_id: string
  title: string
  state_version: number
  created_at: string
  updated_at: string
  workspace: {
    root: string
    repository: string
    baseline: ArtifactRef
    allowed_paths: string[]
  }
  workflow: WorkflowSnapshot
  outer: { phase: Phase; status: Gate; stage_visit: number; iteration: number }
  inner: Lifecycle
  budget: {
    turns_used: number
    turn_limit: number
    execution_failures: number
    execution_failure_limit: number
    repairs_used: number
    repair_limit: number
    no_progress: number
    no_progress_limit: number
  }
  skills: SkillExecutionRecord[]
  stage_context: {
    binding: Binding
    revision: number
    planned_completed: string[]
    execution_records: string[]
    stage_artifacts: ArtifactRef[]
  }
  brief: {
    revision: number
    digest: string
    artifact: ArtifactRef
    confirmed: Approval | null
  }
  shape: ShapeSnapshot | null
  candidate: BuilderHandoff | null
  verification: VerificationSnapshot | null
  interaction: Interaction | null
  blocker: Blocker | null
  finalization: Finalization
  history: TransitionRecord[]
}

export type Decision =
  | { kind: 'dispatch'; action: Action; skill_index: number | null }
  | { kind: 'evaluate'; operation_id: string }
  | { kind: 'advance'; action: Action }
  | { kind: 'reconcile'; operation_id: string }
  | { kind: 'wait'; reason: 'await-user' | 'blocked' | 'paused' | 'executing' }
  | { kind: 'done' }

export interface ResolvedSkill {
  name: string
  path: string
  content: Uint8Array
  resources: { path: string; content: Uint8Array }[]
  source_commit: string | null
}

export interface MutationRequest<ActionName extends string = string, Payload = unknown> {
  expectedVersion: number
  actionId: string
  action: ActionName
  payload: Payload
}

export interface MutationReceipt {
  actionId: string
  payloadDigest: string
  previousVersion: number
  stateVersion: number
  replayed: boolean
}

export interface StateMutationStore {
  mutate<ActionName extends string, Payload>(
    changeId: string,
    request: MutationRequest<ActionName, Payload>,
  ): Promise<MutationReceipt>
}
