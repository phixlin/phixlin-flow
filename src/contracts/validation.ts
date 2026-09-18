import { posix } from 'node:path'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import { parseDocument } from 'yaml'
import eventSchema from '../../schemas/event-v1.schema.json' with { type: 'json' }
import executionResultSchema from '../../schemas/execution-result-v1.schema.json' with { type: 'json' }
import stateSchema from '../../schemas/flow-state-v1.schema.json' with { type: 'json' }
import reducerVectorsSchema from '../../schemas/reducer-vectors-v1.schema.json' with { type: 'json' }
import workflowSchema from '../../schemas/workflow-profile-v1.schema.json' with { type: 'json' }
import { ContractError } from './error.js'
import type {
  Action,
  ArtifactRef,
  Binding,
  ChangeState,
  Lifecycle,
  WorkflowProfile,
} from './types.js'

const ajv = new Ajv2020({ allErrors: true, strict: true })
const stateValidator = ajv.compile(stateSchema)
const workflowValidator = ajv.compile(workflowSchema)
const executionResultValidator = ajv.compile(executionResultSchema)
const eventValidator = ajv.compile(eventSchema)
const reducerVectorsValidator = ajv.compile(reducerVectorsSchema)

function renderSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || '/'
    return `${location} ${error.message ?? 'is invalid'}`
  })
}

function assertSchema(
  validator: ValidateFunction,
  value: unknown,
  code:
    | 'INVALID_STATE'
    | 'INVALID_WORKFLOW_PROFILE'
    | 'INVALID_EXECUTION_RESULT'
    | 'INVALID_EVENT'
    | 'INVALID_REDUCER_VECTORS',
): void {
  if (!validator(value)) throw new ContractError(code, renderSchemaErrors(validator.errors))
}

function parseYaml(source: string, code: 'INVALID_STATE' | 'INVALID_WORKFLOW_PROFILE'): unknown {
  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new ContractError(
      code,
      document.errors.map((error) => error.message),
    )
  }
  return document.toJS({ maxAliasCount: 0 }) as unknown
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return 'path' in candidate && 'sha256' in candidate && 'bytes' in candidate
}

function visitArtifactRefs(value: unknown, visit: (artifact: ArtifactRef) => void): void {
  if (isArtifactRef(value)) visit(value)
  if (Array.isArray(value)) {
    for (const item of value) visitArtifactRefs(item, visit)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      visitArtifactRefs(item, visit)
    }
  }
}

function artifactPathIssue(artifactPath: string): string | null {
  if (artifactPath.includes('\\')) return `artifact path uses a backslash: ${artifactPath}`
  if (posix.normalize(artifactPath) !== artifactPath) {
    return `artifact path is not normalized: ${artifactPath}`
  }
  return null
}

function equalBinding(left: Binding, right: Binding): boolean {
  return (
    left.change_id === right.change_id &&
    left.stage_visit === right.stage_visit &&
    left.workflow_digest === right.workflow_digest &&
    left.brief_revision === right.brief_revision &&
    left.spec_revision === right.spec_revision &&
    left.candidate_id === right.candidate_id &&
    left.input_digest === right.input_digest
  )
}

function lifecycleOperation(inner: Lifecycle) {
  if (
    inner.state === 'executing' ||
    inner.state === 'reconciling' ||
    inner.state === 'evaluating'
  ) {
    return inner.operation
  }
  return null
}

const phaseActions: Record<Exclude<ChangeState['outer']['phase'], 'completed'>, Set<Action>> = {
  shape: new Set(['skill', 'agent-work']),
  build: new Set(['skill', 'agent-work', 'capture-candidate', 'review-candidate']),
  verify: new Set(['skill', 'run-checks', 'verify-candidate', 'finalize']),
}

function validateGateAndLifecycle(state: ChangeState, issues: string[]): void {
  const { phase, status } = state.outer
  const innerState = state.inner.state

  if (phase === 'completed') {
    if (status !== 'done' || innerState !== 'idle') {
      issues.push('completed phase requires outer done and inner idle')
    }
  } else {
    if (status === 'done') issues.push('done status requires completed phase')
    if (innerState === 'idle') issues.push('inner idle requires completed phase')
  }

  if (status === 'active') {
    if (!['ready', 'executing', 'reconciling', 'evaluating', 'stage-ready'].includes(innerState)) {
      issues.push(`active status cannot combine with inner ${innerState}`)
    }
    if (state.interaction !== null || state.blocker !== null) {
      issues.push('active status cannot retain interaction or blocker')
    }
  }
  if (status === 'await-user') {
    if (innerState !== 'waiting-user' || state.interaction === null) {
      issues.push('await-user requires waiting-user inner state and interaction')
    }
    if (state.blocker !== null) issues.push('await-user cannot retain blocker')
  }
  if (status === 'blocked') {
    if (innerState !== 'blocked' || state.blocker === null) {
      issues.push('blocked status requires blocked inner state and blocker')
    }
    if (state.interaction !== null) issues.push('blocked status cannot retain interaction')
  }
  if (status === 'done' && (state.interaction !== null || state.blocker !== null)) {
    issues.push('done status cannot retain interaction or blocker')
  }
  if (status === 'paused') {
    if (!['ready', 'executing', 'reconciling', 'evaluating', 'stage-ready', 'waiting-user'].includes(innerState)) {
      issues.push(`paused status cannot combine with inner ${innerState}`)
    }
    if (innerState === 'waiting-user' && state.interaction === null) {
      issues.push('paused waiting-user state requires interaction')
    }
  }

  if (state.inner.state === 'waiting-user') {
    if (state.interaction?.id !== state.inner.interaction_id) {
      issues.push('waiting-user interaction_id does not match interaction')
    }
  }
  if (state.inner.state === 'blocked' && state.blocker?.id !== state.inner.blocker_id) {
    issues.push('blocked blocker_id does not match blocker')
  }

  if ('position' in state.inner) {
    const { action, skill_index: skillIndex } = state.inner.position
    if (phase === 'completed' || !phaseActions[phase].has(action)) {
      issues.push(`action ${action} is not valid in ${phase}`)
    }
    if ((action === 'skill') !== (skillIndex !== null)) {
      issues.push('skill_index must be set exactly when action is skill')
    }
  }
}

function validateBindings(state: ChangeState, issues: string[]): void {
  const currentSpecRevision = state.shape?.spec_revision ?? null
  const currentCandidateId = state.candidate?.candidate_id ?? null
  const expected = {
    ...state.stage_context.binding,
    change_id: state.change_id,
    stage_visit: state.outer.stage_visit,
    workflow_digest: state.workflow.digest,
    brief_revision: state.brief.revision,
    spec_revision: currentSpecRevision,
    candidate_id: currentCandidateId,
  }
  if (!equalBinding(state.stage_context.binding, expected)) {
    issues.push('stage_context binding is stale')
  }

  const operation = lifecycleOperation(state.inner)
  if (operation !== null) {
    if (!equalBinding(operation.binding, state.stage_context.binding)) {
      issues.push('operation binding does not match stage_context')
    }
    if ('position' in state.inner && operation.action !== state.inner.position.action) {
      issues.push('operation action does not match inner position')
    }
  }
  if (state.interaction !== null && !equalBinding(state.interaction.binding, state.stage_context.binding)) {
    issues.push('interaction binding does not match stage_context')
  }
}

function validateSkills(state: ChangeState, issues: string[]): void {
  const stage = state.outer.phase === 'completed' ? 'verify' : state.outer.phase
  const plannedSnapshots = state.workflow.stages[stage]
  const snapshotNames = new Set(plannedSnapshots.map((skill) => skill.name))
  if (snapshotNames.size !== plannedSnapshots.length) {
    issues.push(`workflow ${stage} stage contains duplicate skills`)
  }

  const invocationIds = new Set<string>()
  const plannedIndexes = new Set<number>()
  const completedNames: string[] = []
  for (const skill of state.skills) {
    if (invocationIds.has(skill.invocation_id)) {
      issues.push(`duplicate skill invocation_id ${skill.invocation_id}`)
    }
    invocationIds.add(skill.invocation_id)

    if (skill.mode === 'planned') {
      if (skill.index === null) {
        issues.push(`planned skill ${skill.name} has no index`)
        continue
      }
      if (plannedIndexes.has(skill.index)) issues.push(`duplicate planned skill index ${skill.index}`)
      plannedIndexes.add(skill.index)
      const snapshot = plannedSnapshots[skill.index]
      if (snapshot?.name !== skill.name || snapshot.digest !== skill.source_digest) {
        issues.push(`planned skill ${skill.name} does not match workflow index ${skill.index}`)
      }
      if (skill.observation !== 'host-observed') {
        issues.push(`planned skill ${skill.name} must be host-observed`)
      }
      if (skill.status === 'completed') completedNames.push(skill.name)
    } else if (skill.index !== null) {
      issues.push(`contextual skill ${skill.name} cannot have a planned index`)
    }

    if (skill.status === 'pending') {
      if (
        skill.attempts !== 0 ||
        skill.input_digest !== null ||
        skill.raw_output !== null ||
        skill.workspace_before !== null ||
        skill.workspace_after !== null ||
        skill.completed_by !== null
      ) {
        issues.push(`pending skill ${skill.name} contains execution output`)
      }
    }
    if (skill.status === 'completed') {
      if (
        skill.attempts < 1 ||
        skill.input_digest === null ||
        skill.raw_output === null ||
        skill.workspace_before === null ||
        skill.workspace_after === null ||
        skill.completed_by === null
      ) {
        issues.push(`completed skill ${skill.name} lacks execution evidence`)
      }
    }
  }

  if (plannedIndexes.size !== plannedSnapshots.length) {
    issues.push(`current visit must contain all ${plannedSnapshots.length} planned skill records`)
  }
  if (state.stage_context.planned_completed.join('\0') !== completedNames.join('\0')) {
    issues.push('stage_context planned_completed does not match completed planned skills')
  }
  for (const executionRecord of state.stage_context.execution_records) {
    if (!invocationIds.has(executionRecord)) {
      issues.push(`stage_context references unknown execution record ${executionRecord}`)
    }
  }

  if (state.inner.state === 'ready' && state.inner.position.action === 'skill') {
    const index = state.inner.position.skill_index
    const skill = state.skills.find((item) => item.mode === 'planned' && item.index === index)
    if (skill?.status !== 'pending' && skill?.status !== 'failed') {
      issues.push(`skill position ${String(index)} is not pending or failed`)
    }
    const firstIncomplete = state.skills.find(
      (item) => item.mode === 'planned' && item.status !== 'completed',
    )
    if (firstIncomplete?.index !== index) issues.push('skill position skips an incomplete planned skill')
  }
  if (state.inner.state === 'stage-ready' && completedNames.length !== plannedSnapshots.length) {
    issues.push('stage-ready requires every planned skill to be completed')
  }
}

function validateDeliveryBindings(state: ChangeState, issues: string[]): void {
  if (state.brief.confirmed !== null && state.brief.confirmed.subject_digest !== state.brief.digest) {
    issues.push('brief approval is bound to a different digest')
  }
  if (state.shape !== null) {
    const acceptanceIds = state.shape.acceptance.map((item) => item.id)
    if (new Set(acceptanceIds).size !== acceptanceIds.length) {
      issues.push('shape contains duplicate acceptance ids')
    }
    const checkIds = state.shape.checks.map((item) => item.id)
    if (new Set(checkIds).size !== checkIds.length) issues.push('shape contains duplicate check ids')
    if (state.shape.approval !== null && state.shape.approval.subject_digest !== state.shape.digest) {
      issues.push('shape approval is bound to a different digest')
    }
  }
  if (state.outer.phase === 'build' || state.outer.phase === 'verify' || state.outer.phase === 'completed') {
    if (state.shape?.approval === null || state.shape === null || state.brief.confirmed === null) {
      issues.push(`${state.outer.phase} requires confirmed brief and shape`)
    }
  }

  if (state.candidate !== null) {
    if (state.shape === null || state.candidate.spec_revision !== state.shape.spec_revision) {
      issues.push('candidate is bound to a stale spec revision')
    }
    if (state.candidate.iteration > state.outer.iteration) {
      issues.push('candidate iteration is ahead of outer iteration')
    }
    if (
      state.candidate.review !== null &&
      state.candidate.review.candidate_digest !== state.candidate.candidate_digest
    ) {
      issues.push('candidate review is bound to a different digest')
    }
    if (state.candidate.review?.execution_ref === state.candidate.builder_execution_ref) {
      issues.push('candidate reviewer must use a different execution_ref from builder')
    }
    const acceptanceIds = new Set(state.shape?.acceptance.map((item) => item.id) ?? [])
    for (const acceptanceId of state.candidate.addressed_acceptance_ids) {
      if (!acceptanceIds.has(acceptanceId)) {
        issues.push(`candidate addresses unknown acceptance id ${acceptanceId}`)
      }
    }
  }

  if (state.outer.phase === 'verify' || state.outer.phase === 'completed') {
    if (state.candidate?.review?.verdict !== 'pass') {
      issues.push(`${state.outer.phase} requires a reviewed candidate`)
    }
  }
  if (state.verification !== null) {
    if (
      state.candidate === null ||
      state.verification.candidate_id !== state.candidate.candidate_id ||
      state.verification.candidate_digest !== state.candidate.candidate_digest ||
      state.verification.spec_revision !== state.candidate.spec_revision
    ) {
      issues.push('verification is bound to a stale candidate')
    }
    const verificationIds = state.verification.acceptance.map((item) => item.id)
    if (new Set(verificationIds).size !== verificationIds.length) {
      issues.push('verification contains duplicate acceptance ids')
    }
    const expectedIds = state.shape?.acceptance.map((item) => item.id) ?? []
    if (verificationIds.join('\0') !== expectedIds.join('\0')) {
      issues.push('verification does not cover the frozen acceptance list in order')
    }
    const checkIds = state.verification.checks.map((item) => item.id)
    if (new Set(checkIds).size !== checkIds.length) {
      issues.push('verification contains duplicate check ids')
    }
    const expectedCheckIds = state.shape?.checks.map((item) => item.id) ?? []
    if (checkIds.join('\0') !== expectedCheckIds.join('\0')) {
      issues.push('verification does not cover the frozen check list in order')
    }
    const independentExecutionRefs = [
      state.candidate?.builder_execution_ref,
      state.candidate?.review?.execution_ref,
    ]
    if (
      state.verification.execution_ref !== null &&
      independentExecutionRefs.includes(state.verification.execution_ref)
    ) {
      issues.push('verifier must use an execution_ref distinct from builder and reviewer')
    }
    if (state.verification.verdict === 'pass') {
      if (
        state.verification.checks.some((check) => check.result !== 'pass') ||
        state.verification.acceptance.some((acceptance) => acceptance.result !== 'pass') ||
        state.verification.unresolved_ids.length > 0
      ) {
        issues.push('pass verification requires all checks and acceptance items to pass')
      }
    }
    if (
      state.verification.approval !== null &&
      state.verification.approval.subject_digest !== state.verification.candidate_digest
    ) {
      issues.push('result approval is bound to a different candidate digest')
    }
  }

  if (state.outer.phase === 'completed') {
    if (
      state.verification?.verdict !== 'pass' ||
      state.verification.approval === null ||
      state.finalization.state !== 'completed'
    ) {
      issues.push('completed phase requires approved pass verification and completed finalization')
    }
  }
  if (state.finalization.state !== 'pending') {
    if (
      state.candidate === null ||
      state.finalization.candidate_id !== state.candidate.candidate_id ||
      state.finalization.candidate_digest !== state.candidate.candidate_digest
    ) {
      issues.push('finalization is bound to a stale candidate')
    }
  }
}

function validateHistory(state: ChangeState, issues: string[]): void {
  if (state.history.length !== state.state_version) {
    issues.push('history length must equal state_version in v1')
  }
  const actionIds = new Set<string>()
  for (const [index, record] of state.history.entries()) {
    if (actionIds.has(record.action_id)) issues.push(`duplicate history action_id ${record.action_id}`)
    actionIds.add(record.action_id)
    if (record.from_version !== index || record.to_version !== index + 1) {
      issues.push(`history entry ${index} has a non-contiguous version range`)
    }
  }
  const last = state.history.at(-1)
  if (last !== undefined && last.at !== state.updated_at) {
    issues.push('updated_at must equal the latest history timestamp')
  }
}

export function validateChangeState(value: unknown): ChangeState {
  assertSchema(stateValidator, value, 'INVALID_STATE')
  const state = value as ChangeState
  const issues: string[] = []

  validateGateAndLifecycle(state, issues)
  validateBindings(state, issues)
  validateSkills(state, issues)
  validateDeliveryBindings(state, issues)
  validateHistory(state, issues)
  // Workflow resources share ArtifactRef's shape but live beside their SKILL.md.
  // They are checked by the Workflow snapshot builder, not by the change artifact boundary.
  const artifactDomains = {
    workspace: state.workspace,
    inner: state.inner,
    skills: state.skills,
    stage_context: state.stage_context,
    brief: state.brief,
    shape: state.shape,
    candidate: state.candidate,
    verification: state.verification,
    interaction: state.interaction,
    blocker: state.blocker,
    finalization: state.finalization,
    history: state.history,
  }
  visitArtifactRefs(artifactDomains, (artifact) => {
    const issue = artifactPathIssue(artifact.path)
    if (issue !== null) issues.push(issue)
  })

  if (issues.length > 0) throw new ContractError('INVALID_STATE', issues)
  return state
}

export function parseChangeStateYaml(source: string): ChangeState {
  return validateChangeState(parseYaml(source, 'INVALID_STATE'))
}

export function validateWorkflowProfile(value: unknown): WorkflowProfile {
  assertSchema(workflowValidator, value, 'INVALID_WORKFLOW_PROFILE')
  return value as WorkflowProfile
}

export function parseWorkflowProfileYaml(source: string): WorkflowProfile {
  return validateWorkflowProfile(parseYaml(source, 'INVALID_WORKFLOW_PROFILE'))
}

export function validateExecutionResult(value: unknown): void {
  assertSchema(executionResultValidator, value, 'INVALID_EXECUTION_RESULT')
  const result = value as {
    kind: string
    questions: string[]
    proposal: { affected_acceptance_ids: string[] } | null
  }
  if (result.kind === 'needs-user' && result.questions.length === 0) {
    throw new ContractError('INVALID_EXECUTION_RESULT', [
      'needs-user result requires at least one question',
    ])
  }
  if (result.kind !== 'needs-user' && result.questions.length > 0) {
    throw new ContractError('INVALID_EXECUTION_RESULT', [
      `${result.kind} result cannot contain questions`,
    ])
  }
  const affectedIds = result.proposal?.affected_acceptance_ids ?? []
  if (new Set(affectedIds).size !== affectedIds.length) {
    throw new ContractError('INVALID_EXECUTION_RESULT', [
      'proposal contains duplicate acceptance ids',
    ])
  }
  const artifactIssues: string[] = []
  visitArtifactRefs(result, (artifact) => {
    const issue = artifactPathIssue(artifact.path)
    if (issue !== null) artifactIssues.push(issue)
  })
  if (artifactIssues.length > 0) {
    throw new ContractError('INVALID_EXECUTION_RESULT', artifactIssues)
  }
}

export function validateDiagnosticEvent(value: unknown): void {
  assertSchema(eventValidator, value, 'INVALID_EVENT')
  const issues: string[] = []
  visitArtifactRefs(value, (artifact) => {
    const issue = artifactPathIssue(artifact.path)
    if (issue !== null) issues.push(issue)
  })
  if (issues.length > 0) throw new ContractError('INVALID_EVENT', issues)
}

export function validateReducerVectors(value: unknown): void {
  assertSchema(reducerVectorsValidator, value, 'INVALID_REDUCER_VECTORS')
}
