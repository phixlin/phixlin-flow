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
      const operation: Operation = {
        operation_id: p.operation_id, execution_ref: p.execution_ref,
        binding: structuredClone(state.stage_context.binding), action: position.action,
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
      operationOf(state, p)
      if (!p.confirmed_stopped) fail('INVALID_ACTION', 'execution must be confirmed stopped')
      next.budget.execution_failures += 1
      if (next.budget.execution_failures >= next.budget.execution_failure_limit) {
        const blockedPosition = structuredClone(positionOf(state)); next.outer.status = 'blocked'; next.inner = { state: 'blocked', position: blockedPosition, blocker_id: p.blocker_id ?? `execution-${state.state_version + 1}` }
        next.interaction = null
        next.blocker = { id: (next.inner as any).blocker_id, code: 'EXECUTION_FAILED', reason: p.reason ?? 'External execution failed.', allowed_actions: ['retry', 'inspect'], resume: { state: 'ready', position: blockedPosition } }
      } else next.inner = { state: 'ready', position: structuredClone(positionOf(state)) }
      return commit(state, event, next)
    }
    case 'skill-completed': {
      const op = operationOf(state, p)
      const currentPosition = positionOf(state); if (currentPosition.action !== 'skill') fail('INVALID_ACTION', 'skill completion requires skill action')
      const skill = next.skills.find((s) => s.invocation_id === p.invocation_id)
      if (!skill || skill.mode !== 'planned') fail('INVALID_ACTION', 'planned skill invocation not found')
      skill.status = 'completed'; skill.input_digest = p.input_digest ?? skill.input_digest ?? digestJson(p)
      skill.raw_output = p.raw_output ?? (state.inner.state === 'evaluating' ? (state.inner as any).result : null) ?? { path: `artifacts/${skill.invocation_id}-output.json`, sha256: '0'.repeat(64), bytes: 0 }
      skill.artifacts = p.artifacts ?? skill.artifacts; skill.workspace_before = skill.workspace_before ?? p.workspace_before ?? digestJson(state.workspace)
      skill.workspace_after = p.workspace_after ?? skill.workspace_before; skill.completed_by = op.execution_ref
      next.stage_context.planned_completed = next.skills.filter((s) => s.mode === 'planned' && s.status === 'completed').map((s) => s.name)
      next.stage_context.execution_records = [...next.stage_context.execution_records, skill.invocation_id]
      const nextSkill = next.skills.find((s) => s.mode === 'planned' && s.status !== 'completed')
      next.inner = nextSkill ? { state: 'ready', position: { action: 'skill', skill_index: nextSkill.index, turn: 0, attempt: 0 } } : { state: 'ready', position: { action: 'agent-work', skill_index: null, turn: 0, attempt: 0 } }
      return commit(state, event, next)
    }
    case 'contextual-skill-observed': {
      next.skills.push({ invocation_id: p.invocation_id, mode: 'contextual', index: null, name: p.name ?? 'contextual', source_digest: p.source_digest ?? '0'.repeat(64), observation: p.observation ?? 'host-observed', status: 'completed', attempts: 1, input_digest: p.input_digest ?? digestJson(p), raw_output: p.raw_output ?? { path: `artifacts/${p.invocation_id}-output.json`, sha256: '0'.repeat(64), bytes: 0 }, artifacts: p.artifacts ?? [], workspace_before: p.workspace_before ?? digestJson(state.workspace), workspace_after: p.workspace_after ?? digestJson(state.workspace), completed_by: p.execution_ref ?? p.invocation_id })
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
      next.interaction = null; next.outer.status = 'active'; next.inner = { state: 'ready', position: resumePosition }
      return commit(state, event, next)
    }
    case 'result-continue': {
      operationOf(state, p)
      if (state.outer.phase === 'verify' && p.verdict === 'fail') {
        if (state.budget.repairs_used >= state.budget.repair_limit) {
          next.outer.status = 'await-user'
          const interactionId = p.interaction_id ?? `repair-budget-${state.state_version + 1}`
          next.inner = { state: 'waiting-user', position: { action: 'verify-candidate', skill_index: null, turn: 0, attempt: 0 }, interaction_id: interactionId }
          next.interaction = {
            id: interactionId,
            kind: 'budget',
            binding: structuredClone(state.stage_context.binding),
            questions: [p.reason ?? 'Automatic repair budget exhausted.'],
            answers: [],
            resume: { state: 'ready', position: { action: 'verify-candidate', skill_index: null, turn: 0, attempt: 0 } },
          }
        } else {
          next.outer.phase = 'build'
          next.outer.stage_visit += 1
          next.outer.iteration += 1
          next.budget.repairs_used += 1
          next.verification = null
          next.inner = { state: 'ready', position: { action: next.workflow.stages.build.length ? 'skill' : 'agent-work', skill_index: next.workflow.stages.build.length ? 0 : null, turn: 0, attempt: 0 } }
          resetStage(next, 'build')
        }
      } else {
        next.inner = { state: 'ready', position: structuredClone(positionOf(state)) }
      }
      return commit(state, event, next)
    }
    case 'result-stage-ready': {
      operationOf(state, p); next.inner = { state: 'stage-ready', position: structuredClone(positionOf(state)), evidence: p.evidence }
      return commit(state, event, next, p.evidence)
    }
    case 'brief-change-proposed': {
      next.outer.phase = 'shape'; next.outer.stage_visit += 1; next.outer.status = 'active'; next.candidate = null; next.verification = null; next.shape = null; next.brief.confirmed = null; next.inner = { state: 'ready', position: { action: next.workflow.stages.shape.length ? 'skill' : 'agent-work', skill_index: next.workflow.stages.shape.length ? 0 : null, turn: 0, attempt: 0 } }; next.interaction = null; resetStage(next, 'shape')
      return commit(state, event, next)
    }
    case 'confirm-shape': {
      next.brief.digest = p.subject_digest
      next.brief.confirmed = { actor: p.actor ?? 'user', action_id: event.actionId ?? 'confirm-shape', subject_digest: p.subject_digest, at: event.at ?? state.updated_at }
      next.shape = next.shape ?? { spec_revision: 1, digest: p.subject_digest, documents: [], acceptance: [], checks: [], approval: next.brief.confirmed }
      next.shape.digest = p.subject_digest; next.shape.approval = next.brief.confirmed
      next.outer.phase = 'build'; next.outer.stage_visit += 1; next.inner = { state: 'ready', position: { action: next.workflow.stages.build.length ? 'skill' : 'agent-work', skill_index: next.workflow.stages.build.length ? 0 : null, turn: 0, attempt: 0 } }; resetStage(next, 'build')
      return commit(state, event, next)
    }
    case 'stage-transition': {
      if (state.inner.state !== 'stage-ready') fail('INVALID_ACTION', 'stage transition requires stage-ready')
      if (state.outer.phase === 'build') { next.outer.phase = 'verify'; next.outer.stage_visit += 1; next.inner = { state: 'ready', position: { action: next.workflow.stages.verify.length ? 'skill' : 'run-checks', skill_index: next.workflow.stages.verify.length ? 0 : null, turn: 0, attempt: 0 } }; resetStage(next, 'verify') }
      else if (state.outer.phase === 'shape') { next.outer.phase = 'build'; next.outer.stage_visit += 1; next.inner = { state: 'ready', position: { action: next.workflow.stages.build.length ? 'skill' : 'agent-work', skill_index: next.workflow.stages.build.length ? 0 : null, turn: 0, attempt: 0 } }; resetStage(next, 'build') }
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
