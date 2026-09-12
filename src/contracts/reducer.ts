import { digestJson } from './digest.js'
import { ContractError, type ContractErrorCode } from './error.js'
import { validateChangeState } from './validation.js'
import type { ChangeState, Operation, ArtifactRef } from './types.js'

export interface ReducerEvent {
  type: string
  actionId?: string
  at?: string
  payload: Record<string, any>
}

function fail(code: ContractErrorCode, message: string): never {
  throw new ContractError(code, [message])
}

function operationOf(state: ChangeState, payload: Record<string, any>): Operation {
  const inner = state.inner
  if (!('operation' in inner)) fail('INVALID_ACTION', 'current lifecycle has no operation')
  if (payload.operation_id !== inner.operation.operation_id) fail('STALE_RESULT', 'operation does not match current operation')
  return inner.operation
}

function positionOf(state: ChangeState) {
  if (!('position' in state.inner)) fail('INVALID_ACTION', 'current lifecycle has no position')
  return state.inner.position
}

function resetStage(next: ChangeState, phase: 'shape' | 'build' | 'verify'): void {
  next.budget.turns_used = 0
  next.budget.execution_failures = 0
  const snapshots = next.workflow.stages[phase]
  next.skills = snapshots.map((snapshot, index) => ({
    invocation_id: `${phase}-visit-${next.outer.stage_visit}-skill-${index}`,
    mode: 'planned', index, name: snapshot.name, source_digest: snapshot.digest,
    observation: 'host-observed', status: 'pending', attempts: 0,
    input_digest: null, raw_output: null, artifacts: [], workspace_before: null,
    workspace_after: null, completed_by: null,
  }))
  next.stage_context.revision += 1
  next.stage_context.planned_completed = []
  next.stage_context.execution_records = []
  next.stage_context.stage_artifacts = []
  next.stage_context.binding = {
    ...next.stage_context.binding,
    stage_visit: next.outer.stage_visit,
    spec_revision: next.shape?.spec_revision ?? null,
    candidate_id: next.candidate?.candidate_id ?? null,
  }
}

function commit(state: ChangeState, event: ReducerEvent, next: ChangeState, evidence: ArtifactRef[] = []): ChangeState {
  if (['skill-completed', 'result-continue', 'result-stage-ready', 'publish-shape', 'capture-candidate', 'review-candidate', 'run-checks', 'verify-candidate'].includes(event.type)) next.budget.execution_failures = 0
  const actionId = event.actionId ?? String(event.payload.action_id ?? `${event.type}-${state.state_version + 1}`)
  const at = event.at ?? String(event.payload.at ?? state.updated_at)
  next.state_version = state.state_version + 1
  next.updated_at = at
  next.history = [...state.history, {
    action_id: actionId,
    payload_digest: digestJson(event.payload),
    action: event.type,
    from_version: state.state_version,
    to_version: next.state_version,
    at,
    before: { phase: state.outer.phase, status: state.outer.status, inner_state: state.inner.state },
    after: { phase: next.outer.phase, status: next.outer.status, inner_state: next.inner.state },
    evidence,
  }]
  validateChangeState(next)
  return next
}

export function reduce(state: ChangeState, event: ReducerEvent): ChangeState {
  validateChangeState(state)
  const next = structuredClone(state)
  const p = event.payload
  switch (event.type) {
    case 'reserve-operation': {
      if (state.outer.status !== 'active' || state.inner.state !== 'ready') fail('INVALID_ACTION', 'reserve requires active ready state')
      if (state.budget.turns_used >= state.budget.turn_limit) fail('INVALID_ACTION', 'turn budget exhausted')
      const position = state.inner.position
      next.stage_context.binding.input_digest = p.input_digest ?? state.stage_context.binding.input_digest
      const operation: Operation = {
        operation_id: p.operation_id, execution_ref: p.execution_ref,
        binding: structuredClone(next.stage_context.binding), action: position.action,
        attempt: position.attempt + 1, reserved_at: event.at ?? state.updated_at,
        process: p.process ?? null,
      }
      next.inner = { state: 'executing', position: structuredClone(position), operation }
      next.budget.turns_used += 1
      if (position.action === 'skill' && position.skill_index !== null) {
        const skill = next.skills.find((s) => s.mode === 'planned' && s.index === position.skill_index)
        if (skill) { skill.status = 'running'; skill.attempts += 1; skill.input_digest = p.input_digest ?? null; skill.workspace_before = p.workspace_before ?? null }
      }
      return commit(state, event, next)
    }
    case 'execution-result': {
      const operation = operationOf(state, p)
      const result: ArtifactRef = typeof p.result === 'string' ? { path: p.result, sha256: p.sha256 ?? '0'.repeat(64), bytes: p.bytes ?? 0 } : p.result
      next.inner = { state: 'evaluating', position: structuredClone(positionOf(state)), operation, result }
      return commit(state, event, next, [result])
    }
    case 'execution-lost': {
      const operation = operationOf(state, p)
      next.inner = { state: 'reconciling', position: structuredClone(positionOf(state)), operation }
      return commit(state, event, next)
    }
    case 'execution-error': {
      const operation = operationOf(state, p)
      const position = { ...positionOf(state), attempt: operation.attempt }
      const skill = next.skills.find((item) => item.mode === 'planned' && item.index === position.skill_index)
      if (position.action === 'skill' && skill) skill.status = 'failed'
      if (!p.confirmed_stopped) fail('INVALID_ACTION', 'execution must be confirmed stopped')
      next.budget.execution_failures += 1
      if (next.budget.execution_failures >= next.budget.execution_failure_limit) {
        const blockedPosition = position; next.outer.status = 'blocked'; next.inner = { state: 'blocked', position: blockedPosition, blocker_id: p.blocker_id ?? `execution-${state.state_version + 1}` }
        next.interaction = null
        next.blocker = { id: (next.inner as any).blocker_id, code: 'EXECUTION_FAILED', reason: p.reason ?? 'External execution failed.', allowed_actions: ['retry', 'inspect'], resume: { state: 'ready', position: blockedPosition } }
      } else next.inner = { state: 'ready', position }
      return commit(state, event, next)
    }
    case 'skill-completed': {
      const op = operationOf(state, p)
      if (state.inner.state !== 'evaluating') fail('INVALID_ACTION', 'skill completion requires collected output')
      const currentPosition = positionOf(state); if (currentPosition.action !== 'skill') fail('INVALID_ACTION', 'skill completion requires skill action')
      const skill = next.skills.find((s) => s.invocation_id === p.invocation_id)
      if (!skill || skill.mode !== 'planned' || skill.index !== currentPosition.skill_index || skill.status !== 'running') fail('INVALID_ACTION', 'planned skill invocation not current')
      skill.status = 'completed'; skill.input_digest = p.input_digest ?? skill.input_digest ?? digestJson(p)
      skill.raw_output = p.raw_output ?? state.inner.result
      skill.artifacts = p.artifacts ?? skill.artifacts; skill.workspace_before = skill.workspace_before ?? p.workspace_before ?? digestJson(state.workspace)
      skill.workspace_after = p.workspace_after ?? skill.workspace_before; skill.completed_by = op.execution_ref
      next.stage_context.planned_completed = next.skills.filter((s) => s.mode === 'planned' && s.status === 'completed').map((s) => s.name)
      next.stage_context.execution_records = [...next.stage_context.execution_records, skill.invocation_id]
      const nextSkill = next.skills.find((s) => s.mode === 'planned' && s.status !== 'completed')
      next.inner = nextSkill ? { state: 'ready', position: { action: 'skill', skill_index: nextSkill.index, turn: 0, attempt: 0 } } : { state: 'ready', position: { action: state.outer.phase === 'verify' ? 'run-checks' : 'agent-work', skill_index: null, turn: 0, attempt: 0 } }
      return commit(state, event, next)
    }
    case 'contextual-skill-observed': {
      const operation = operationOf(state, p)
      if (state.inner.state !== 'evaluating') fail('INVALID_ACTION', 'contextual observation requires collected output')
      next.skills.push({ invocation_id: p.invocation_id, mode: 'contextual', index: null, name: p.name, source_digest: p.source_digest ?? digestJson(p.name), observation: p.observation, status: p.status, attempts: 1, input_digest: operation.binding.input_digest, raw_output: p.raw_output ?? state.inner.result, artifacts: p.artifacts, workspace_before: state.workspace.baseline.sha256, workspace_after: state.candidate?.candidate_digest ?? state.workspace.baseline.sha256, completed_by: operation.execution_ref })
      next.stage_context.execution_records.push(p.invocation_id)
      return commit(state, event, next)
    }
    case 'result-needs-user': {
      const interactionId = p.interaction_id
      const waitingPosition = structuredClone(positionOf(state)); next.outer.status = 'await-user'; next.inner = { state: 'waiting-user', position: waitingPosition, interaction_id: interactionId }
      next.interaction = { id: interactionId, kind: p.kind ?? 'question', binding: structuredClone(state.stage_context.binding), questions: p.questions ?? [], answers: [], resume: { state: 'ready', position: waitingPosition } }
      return commit(state, event, next)
    }
    case 'user-answer': {
      if (state.interaction?.id !== p.interaction_id) fail('INVALID_ACTION', 'interaction does not match')
      if (state.interaction === null) fail('INVALID_ACTION', 'interaction does not match')
      const resumePosition = structuredClone(state.interaction.resume.position)
      const skill = next.skills.find((item) => item.mode === 'planned' && item.index === resumePosition.skill_index)
      if (resumePosition.action === 'skill' && skill) skill.status = 'failed'
      next.interaction = null; next.outer.status = 'active'; next.inner = { state: 'ready', position: resumePosition }
      return commit(state, event, next)
    }
    case 'result-continue': {
      operationOf(state, p)
      if (p.verdict !== undefined) fail('INVALID_ACTION', 'verification verdicts require verify-candidate')
      const position = positionOf(state)
      const skill = next.skills.find((item) => item.mode === 'planned' && item.index === position.skill_index)
      if (position.action === 'skill' && skill) skill.status = 'failed'
      next.inner = { state: 'ready', position: structuredClone(position) }
      return commit(state, event, next)
    }
    case 'result-stage-ready': {
      operationOf(state, p); next.inner = { state: 'stage-ready', position: structuredClone(positionOf(state)), evidence: p.evidence }
      return commit(state, event, next, p.evidence)
    }
    case 'capture-candidate': {
      const operation = operationOf(state, p)
      if (state.outer.phase !== 'build' || state.inner.state !== 'evaluating' || operation.action !== 'agent-work' || p.builder_execution_ref !== operation.execution_ref) fail('INVALID_ACTION', 'candidate capture requires collected Build output')
      if (state.skills.some((skill) => skill.mode === 'planned' && skill.status !== 'completed')) fail('INVALID_ACTION', 'candidate requires all planned Skills')
      if (!p.candidate_id || !p.candidate_digest || !p.file_manifest || !p.diff || !p.builder_execution_ref) fail('INVALID_ACTION', 'candidate handoff is incomplete')
      next.candidate = { candidate_id: p.candidate_id, spec_revision: state.shape?.spec_revision ?? 0, iteration: state.outer.iteration, candidate_digest: p.candidate_digest, file_manifest: p.file_manifest, diff: p.diff, builder_execution_ref: p.builder_execution_ref, summary: p.summary ?? '', addressed_acceptance_ids: p.addressed_acceptance_ids ?? [], known_limits: p.known_limits ?? [], review: null }
      next.stage_context.binding.candidate_id = p.candidate_id
      next.verification = null
      next.finalization = { state: 'pending' }
      next.inner = { state: 'ready', position: { action: 'review-candidate', skill_index: null, turn: 0, attempt: 0 } }
      return commit(state, event, next, [p.file_manifest, p.diff, ...(p.previous_candidate ? [p.previous_candidate] : [])])
    }
    case 'review-candidate': {
      const operation = operationOf(state, p)
      if (state.inner.state !== 'evaluating' || operation.action !== 'review-candidate' || p.execution_ref !== operation.execution_ref) fail('INVALID_ACTION', 'review requires collected independent execution')
      if (state.outer.phase !== 'build' || state.candidate === null) fail('INVALID_ACTION', 'review requires current candidate')
      if (p.candidate_id !== state.candidate.candidate_id || p.candidate_digest !== state.candidate.candidate_digest) fail('STALE_RESULT', 'review candidate binding mismatch')
      next.candidate = { ...state.candidate, review: { execution_ref: p.execution_ref, candidate_digest: p.candidate_digest, verdict: p.verdict, report: p.report } }
      next.inner = p.verdict === 'pass' ? { state: 'stage-ready', position: { action: 'review-candidate', skill_index: null, turn: 0, attempt: 0 }, evidence: [p.report] } : { state: 'ready', position: { action: 'agent-work', skill_index: null, turn: 0, attempt: 0 } }
      return commit(state, event, next, [p.report])
    }
    case 'run-checks': {
      const operation = operationOf(state, p)
      if (state.inner.state !== 'evaluating' || operation.action !== 'run-checks') fail('INVALID_ACTION', 'checks require collected check execution')
      if (state.outer.phase !== 'verify' || state.candidate === null) fail('INVALID_ACTION', 'checks require Verify candidate')
      if (p.candidate_id !== state.candidate.candidate_id || p.candidate_digest !== state.candidate.candidate_digest) fail('STALE_RESULT', 'check candidate binding mismatch')
      next.verification = { candidate_id: state.candidate.candidate_id, candidate_digest: state.candidate.candidate_digest, spec_revision: state.candidate.spec_revision, attempt: state.outer.iteration, execution_ref: null, checks: p.checks, acceptance: state.shape!.acceptance.map(({ id }) => ({ id, result: 'pending', reason: '' })), verdict: 'pending', unresolved_ids: [], approval: null }
      for (const check of next.verification.checks) {
        if (!check.report || check.exit_code === null || !['pass', 'fail'].includes(check.result) || (check.result === 'pass') !== (check.exit_code === 0)) fail('INVALID_EXECUTION_RESULT', 'host checks require a report and consistent exit status')
      }
      next.inner = { state: 'ready', position: { action: 'verify-candidate', skill_index: null, turn: 0, attempt: 0 } }
      return commit(state, event, next)
    }
    case 'verify-candidate': {
      const operation = operationOf(state, p)
      if (state.inner.state !== 'evaluating' || operation.action !== 'verify-candidate' || p.execution_ref !== operation.execution_ref) fail('INVALID_ACTION', 'verification requires collected verifier execution')
      if (state.verification === null || state.candidate === null) fail('INVALID_ACTION', 'verification requires checks')
      next.verification = structuredClone(state.verification)
      if (p.candidate_id !== state.candidate.candidate_id || p.candidate_digest !== state.candidate.candidate_digest) fail('STALE_RESULT', 'verification candidate binding mismatch')
      if (p.execution_ref === state.candidate.builder_execution_ref || p.execution_ref === state.candidate.review?.execution_ref) fail('INVALID_ACTION', 'verifier must be independent')
      next.verification.execution_ref = p.execution_ref
      if (p.checks !== undefined) fail('INVALID_ACTION', 'verifier cannot replace host checks')
      next.verification.acceptance = p.acceptance
      next.verification.unresolved_ids = [...next.verification.checks.filter((check) => check.result !== 'pass').map((check) => check.id), ...next.verification.acceptance.filter((item) => item.result !== 'pass').map((item) => item.id)]
      next.verification.verdict = next.verification.unresolved_ids.length ? 'fail' : p.verdict
      next.inner = { state: 'stage-ready', position: { action: 'verify-candidate', skill_index: null, turn: 0, attempt: 0 }, evidence: p.evidence ?? [] }
      return commit(state, event, next, p.evidence ?? [])
    }
    case 'brief-change-proposed': {
      next.outer.phase = 'shape'; next.outer.stage_visit += 1; next.outer.status = 'active'; next.candidate = null; next.verification = null; next.shape = null; next.brief.confirmed = null; next.inner = { state: 'ready', position: { action: next.workflow.stages.shape.length ? 'skill' : 'agent-work', skill_index: next.workflow.stages.shape.length ? 0 : null, turn: 0, attempt: 0 } }; next.interaction = null; resetStage(next, 'shape')
      return commit(state, event, next)
    }
    case 'candidate-drift': {
      if (!state.candidate || !['build', 'verify'].includes(state.outer.phase)) fail('INVALID_ACTION', 'candidate drift requires a current candidate')
      next.outer.phase = 'build'
      next.outer.status = 'active'
      next.outer.stage_visit += 1
      next.candidate = null
      next.verification = null
      next.finalization = { state: 'pending' }
      next.interaction = null
      next.blocker = null
      next.inner = { state: 'ready', position: { action: next.workflow.stages.build.length ? 'skill' : 'agent-work', skill_index: next.workflow.stages.build.length ? 0 : null, turn: 0, attempt: 0 } }
      resetStage(next, 'build')
      return commit(state, event, next, [state.candidate.file_manifest, state.candidate.diff])
    }
    case 'finish-verification': {
      if (state.outer.phase !== 'verify' || state.inner.state !== 'stage-ready' || !state.verification || !state.candidate) fail('INVALID_ACTION', 'verification is not ready')
      const verification = state.verification
      if (verification.verdict !== 'pass' && verification.verdict !== 'fail') fail('INVALID_ACTION', 'verification has no verdict')
      const previous: string[] | undefined = p.previous_unresolved_ids
      if (verification.verdict === 'fail') next.budget.no_progress = previous && verification.unresolved_ids.length >= previous.length ? state.budget.no_progress + 1 : 0
      if (verification.verdict === 'pass' || state.budget.repairs_used >= state.budget.repair_limit || next.budget.no_progress >= state.budget.no_progress_limit) {
        const id = `verification-${state.state_version + 1}`
        const position = state.inner.position
        next.outer.status = 'await-user'
        next.inner = { state: 'waiting-user', position, interaction_id: id }
        next.interaction = { id, kind: verification.verdict === 'pass' ? 'result-approval' : 'budget', binding: structuredClone(state.stage_context.binding), questions: [verification.verdict === 'pass' ? 'Accept this candidate?' : 'Automatic repair budget exhausted.'], answers: [], resume: { state: 'stage-ready', position, evidence: state.inner.evidence } }
      } else {
        next.outer.phase = 'build'
        next.outer.stage_visit += 1
        next.outer.iteration += 1
        next.budget.repairs_used += 1
        next.verification = null
        next.inner = { state: 'ready', position: { action: next.workflow.stages.build.length ? 'skill' : 'agent-work', skill_index: next.workflow.stages.build.length ? 0 : null, turn: 0, attempt: 0 } }
        resetStage(next, 'build')
      }
      return commit(state, event, next, p.evidence ?? state.inner.evidence)
    }
    case 'confirm-shape': {
      if (state.outer.phase !== 'shape' || state.interaction?.kind !== 'shape-approval' || !state.shape || p.subject_digest !== state.shape.digest) fail('STALE_RESULT', 'shape approval must match current proposal')
      const approval = { actor: p.actor, action_id: event.actionId ?? 'confirm-shape', subject_digest: p.subject_digest, at: event.at ?? state.updated_at }
      next.brief.confirmed = { ...approval, subject_digest: state.brief.digest }
      next.shape = { ...state.shape, approval }
      next.interaction = null
      next.outer.status = 'active'
      next.outer.iteration = Math.max(1, state.outer.iteration)
      next.outer.phase = 'build'; next.outer.stage_visit += 1; next.inner = { state: 'ready', position: { action: next.workflow.stages.build.length ? 'skill' : 'agent-work', skill_index: next.workflow.stages.build.length ? 0 : null, turn: 0, attempt: 0 } }; resetStage(next, 'build')
      return commit(state, event, next)
    }
    case 'publish-shape': {
      const operation = operationOf(state, p)
      if (state.outer.phase !== 'shape' || state.inner.state !== 'evaluating' || operation.action !== 'agent-work') fail('INVALID_ACTION', 'shape output requires collected stage output')
      if (state.skills.some((skill) => skill.mode === 'planned' && skill.status !== 'completed')) fail('INVALID_ACTION', 'shape requires all planned Skills')
      next.shape = { ...p.shape, spec_revision: state.brief.revision, digest: digestJson(p.shape), approval: null }
      next.stage_context.binding.spec_revision = state.brief.revision
      const id = `shape-approval-${state.state_version + 1}`
      next.outer.status = 'await-user'
      next.inner = { state: 'waiting-user', position: state.inner.position, interaction_id: id }
      next.interaction = { id, kind: 'shape-approval', binding: structuredClone(next.stage_context.binding), questions: ['Confirm this specification?'], answers: [], resume: { state: 'stage-ready', position: state.inner.position, evidence: [state.inner.result] } }
      return commit(state, event, next, p.shape.documents)
    }
    case 'stage-transition': {
      if (state.inner.state !== 'stage-ready') fail('INVALID_ACTION', 'stage transition requires stage-ready')
      if (state.outer.phase === 'build') { next.outer.phase = 'verify'; next.outer.stage_visit += 1; next.inner = { state: 'ready', position: { action: next.workflow.stages.verify.length ? 'skill' : 'run-checks', skill_index: next.workflow.stages.verify.length ? 0 : null, turn: 0, attempt: 0 } }; resetStage(next, 'verify') }
      else fail('INVALID_ACTION', 'cannot transition from current phase')
      return commit(state, event, next)
    }
    case 'accept-result': {
      if (!state.verification || state.verification.verdict !== 'pass' || state.candidate === null || state.candidate.candidate_id !== p.candidate_id || state.candidate.candidate_digest !== p.candidate_digest) fail('INVALID_ACTION', 'result is not current and passing')
      next.verification!.approval = { actor: p.actor ?? 'user', action_id: event.actionId ?? 'accept-result', subject_digest: p.candidate_digest, at: event.at ?? state.updated_at }; next.outer.status = 'active'; next.inner = { state: 'ready', position: { action: 'finalize', skill_index: null, turn: 0, attempt: 0 } }
      return commit(state, event, next)
    }
    case 'finalize': {
      if (!state.verification?.approval || !state.candidate || p.candidate_id !== state.candidate.candidate_id) fail('INVALID_ACTION', 'finalize requires approved current candidate')
      next.finalization = { state: 'completed', candidate_id: state.candidate.candidate_id, candidate_digest: state.candidate.candidate_digest, artifacts: p.archive ? [{ path: p.archive, sha256: p.sha256 ?? '0'.repeat(64), bytes: p.bytes ?? 0 }] : [] }
      next.outer.phase = 'completed'; next.outer.status = 'done'; next.inner = { state: 'idle' }
      return commit(state, event, next, next.finalization.artifacts)
    }
    default: fail('INVALID_ACTION', `unknown reducer event ${event.type}`)
  }
}
