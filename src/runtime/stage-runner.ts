import { randomUUID } from 'node:crypto'
import { ContractError } from '../contracts/error.js'
import { decide } from '../contracts/decide.js'
import { digestJson } from '../contracts/digest.js'
import { validateExecutionResult, validateShapeContent } from '../contracts/validation.js'
import type { ChangeState, Decision, MutationReceipt, MutationRequest } from '../contracts/types.js'
import type { RuntimeAdapter, RuntimeResult } from './fake.js'
import type { FileEvidenceStore } from './evidence.js'
import type { FileSkillResolver } from './skill-resolver.js'

export interface StageRunnerOptions {
  evidence: FileEvidenceStore
  skills: FileSkillResolver
}

export type DriveResult = { state: ChangeState; decision: Decision; steps: number }
export interface MutationPort {
  read(changeId: string): Promise<ChangeState>
  mutate(changeId: string, request: MutationRequest<string, Record<string, unknown>>): Promise<MutationReceipt>
}

/** Drives controller-owned mutations; external runtime calls happen outside the CAS lock. */
export class StageRunner {
  private readonly evidence: FileEvidenceStore
  private readonly skills: FileSkillResolver

  constructor(
    private readonly store: MutationPort,
    private readonly runtime: RuntimeAdapter,
    options: StageRunnerOptions,
  ) {
    this.evidence = options.evidence
    this.skills = options.skills
  }

  private async mutate(changeId: string, state: ChangeState, action: string, payload: Record<string, unknown>): Promise<ChangeState> {
    const request: MutationRequest<string, Record<string, unknown>> = { expectedVersion: state.state_version, expectedStateDigest: digestJson(state), actionId: randomUUID(), action, payload }
    await this.store.mutate(changeId, request)
    return this.store.read(changeId)
  }

  private async evaluate(changeId: string, state: ChangeState): Promise<ChangeState> {
    if (state.inner.state !== 'evaluating') throw new ContractError('INVALID_ACTION', ['evaluate requires evaluating state'])
    const currentPosition = state.inner.position
    const operation = state.inner.operation
    const operationId = state.inner.operation.operation_id
    if (!(await this.candidateIntact(state))) return this.mutate(changeId, state, 'candidate-drift', {})
    const envelope = JSON.parse(await this.evidence.read(state.inner.result))
    if (digestJson(envelope.operation) !== digestJson(operation)) throw new ContractError('STALE_RESULT', ['persisted result belongs to a different operation'])
    const result: RuntimeResult = envelope.result
    validateExecutionResult({ schema: 'phixlin.execution-result.v1', binding: { change_id: state.change_id, stage_visit: state.outer.stage_visit, input_digest: operation.binding.input_digest }, kind: result.kind, summary: result.summary, artifacts: result.artifacts, questions: result.questions, proposal: result.proposal, skill_invocations: result.skill_invocations ?? [] })
    if (currentPosition.action === 'agent-work' && state.outer.phase === 'shape' && result.kind === 'stage-ready' && result.shape) {
      try { validateShapeContent(result.shape) }
      catch (error) {
        if (!(error instanceof ContractError) || error.code !== 'INVALID_EXECUTION_RESULT') throw error
        return this.mutate(changeId, state, 'execution-error', { operation_id: operationId, confirmed_stopped: true, manual_retry: true, reason: error.message, evidence: [state.inner.result] })
      }
    }
    for (const [index, invocation] of (result.skill_invocations ?? []).entries()) {
      const invocationId = `${operationId}-contextual-${index}`
      if (state.skills.some((skill) => skill.invocation_id === invocationId)) continue
      state = await this.mutate(changeId, state, 'contextual-skill-observed', {
        operation_id: operationId,
        invocation_id: invocationId,
        name: invocation.name,
        observation: invocation.observation,
        status: invocation.status,
        raw_output: invocation.artifact,
        artifacts: invocation.artifact ? [invocation.artifact] : [],
        execution_ref: operation.execution_ref,
      })
    }
    const payload: Record<string, unknown> = { operation_id: operationId }
    if (result.proposal) return this.mutate(changeId, state, 'brief-change-proposed', { ...payload, ...result.proposal })
    if (result.kind === 'needs-user') {
      payload.interaction_id = `interaction-${operationId}`
      payload.questions = result.questions
      return this.mutate(changeId, state, 'result-needs-user', payload)
    }
    if (result.kind === 'blocked') {
      return this.mutate(changeId, state, 'execution-error', { operation_id: operationId, confirmed_stopped: true, reason: result.summary })
    }
    if (currentPosition.action === 'skill' && result.kind === 'stage-ready') {
      const skill = state.skills.find((item) => item.mode === 'planned' && item.index === currentPosition.skill_index)
      if (skill === undefined) throw new ContractError('INVALID_ACTION', ['planned skill record is missing'])
      return this.mutate(changeId, state, 'skill-completed', {
        operation_id: operationId,
        invocation_id: skill.invocation_id,
        raw_output: result.raw_output,
        artifacts: result.artifacts,
        input_digest: operation.binding.input_digest,
        workspace_after: state.candidate?.candidate_digest ?? state.workspace.baseline.sha256,
      })
    }
    if (result.kind === 'stage-ready') {
      if (state.outer.phase === 'shape' && result.shape) {
        return this.mutate(changeId, state, 'publish-shape', { operation_id: operationId, shape: result.shape })
      }
      const binding = { operation_id: operationId, execution_ref: operation.execution_ref, candidate_id: state.candidate?.candidate_id, candidate_digest: state.candidate?.candidate_digest }
      if (currentPosition.action === 'review-candidate') {
        if (!result.review) throw new ContractError('INVALID_EXECUTION_RESULT', ['review output missing'])
        return this.mutate(changeId, state, 'review-candidate', { ...binding, ...result.review })
      }
      if (currentPosition.action === 'run-checks') {
        if (!result.checks) throw new ContractError('INVALID_EXECUTION_RESULT', ['host checks missing'])
        if (result.checks.some((check) => check.result === 'error')) return this.mutate(changeId, state, 'execution-error', { operation_id: operationId, confirmed_stopped: true, reason: 'Machine check execution error' })
        return this.mutate(changeId, state, 'run-checks', { ...binding, checks: result.checks })
      }
      if (currentPosition.action === 'verify-candidate') {
        if (!result.verification) throw new ContractError('INVALID_EXECUTION_RESULT', ['verifier output missing'])
        return this.mutate(changeId, state, 'verify-candidate', { ...binding, ...result.verification, evidence: [result.raw_output] })
      }
      if (state.outer.phase === 'build' && currentPosition.action === 'agent-work' && result.candidate) {
        const previous = state.candidate ? await this.evidence.write(JSON.stringify(state.candidate)) : undefined
        return this.mutate(changeId, state, 'capture-candidate', { ...result.candidate, candidate_digest: result.candidate.file_manifest.sha256, operation_id: operationId, ...(previous ? { previous_candidate: previous } : {}), candidate_id: `candidate-${operationId}`, builder_execution_ref: operation.execution_ref })
      }
      return this.mutate(changeId, state, 'result-stage-ready', { operation_id: operationId, evidence: result.artifacts.length > 0 ? result.artifacts : [result.raw_output] })
    }
    return this.mutate(changeId, state, 'result-continue', { operation_id: operationId })
  }

  private async candidateIntact(state: ChangeState): Promise<boolean> {
    if (!state.candidate || (state.outer.phase === 'build' && 'position' in state.inner && state.inner.position.action !== 'review-candidate')) return true
    try { await this.evidence.read(state.candidate.file_manifest) }
    catch (error) {
      if (error instanceof ContractError && error.code === 'RESOURCE_DRIFT') return false
      throw error
    }
    try { await this.evidence.read(state.candidate.diff) }
    catch (error) {
      if (error instanceof ContractError && error.code === 'RESOURCE_DRIFT') return false
      throw error
    }
    if (this.runtime.inspectCandidate && await this.runtime.inspectCandidate() !== state.candidate.candidate_digest) return false
    return true
  }

  private async skillInput(state: ChangeState, position: { action: string; skill_index: number | null }): Promise<string> {
    if (state.outer.phase === 'completed') throw new ContractError('INVALID_ACTION', ['completed change cannot dispatch'])
    const preceding = state.skills
      .filter((skill) => skill.mode === 'planned' && skill.status === 'completed')
      .map((skill) => ({ invocation_id: skill.invocation_id, name: skill.name, raw_output: skill.raw_output, artifacts: skill.artifacts }))
    const snapshots = state.workflow.stages[state.outer.phase]
    const skill = position.skill_index === null ? null : snapshots[position.skill_index]
    const instructions = []
    for (const snapshot of snapshots.slice(0, position.skill_index === null ? snapshots.length : position.skill_index + 1)) instructions.push({ name: snapshot.name, content: await this.skills.load(snapshot) })
    const predecessor = preceding.at(-1)?.raw_output
    const predecessor_output = predecessor ? await this.evidence.read(predecessor) : null
    const brief_content = await this.evidence.read(state.brief.artifact)
    const specifications = []
    for (const document of state.shape?.documents ?? []) specifications.push({ reference: document, content: await this.evidence.read(document) })
    const workspace_diff = state.candidate ? await this.evidence.read(state.candidate.diff) : null
    const stage_artifacts = []
    for (const reference of state.stage_context.stage_artifacts) stage_artifacts.push({ reference, content: await this.evidence.read(reference) })
    return JSON.stringify({ brief: state.brief, brief_content, shape: state.shape, specifications, phase: state.outer.phase, stage_visit: state.outer.stage_visit, skill, instructions, preceding, predecessor_output, stage_artifacts, workspace: state.workspace, workspace_diff, candidate: state.candidate, verification: state.verification })
  }

  async drive(changeId: string, maxSteps = 100, dispatch = true): Promise<DriveResult> {
    let state = await this.store.read(changeId)
    let steps = 0
    while (steps++ < maxSteps) {
      const decision = decide(state)
      if (decision.kind === 'wait' || decision.kind === 'done') return { state, decision, steps }
      if (decision.kind === 'reconcile') return { state, decision, steps }
      if (decision.kind === 'evaluate') {
        state = await this.evaluate(changeId, state)
        continue
      }
      if (decision.kind === 'advance') {
        if (!(await this.candidateIntact(state))) {
          state = await this.mutate(changeId, state, 'candidate-drift', {})
          continue
        }
        if (state.outer.phase === 'build' && decision.action === 'review-candidate') {
          state = await this.mutate(changeId, state, 'stage-transition', {})
          continue
        }
        if (state.outer.phase === 'verify' && decision.action === 'verify-candidate') {
          const payload: Record<string, unknown> = {}
          const previous = [...state.history].reverse().find((entry) => entry.action === 'finish-verification')
          if (previous) payload.previous_unresolved_ids = JSON.parse(await this.evidence.read(previous.evidence[0])).unresolved_ids
          payload.evidence = [await this.evidence.write(JSON.stringify(state.verification))]
          state = await this.mutate(changeId, state, 'finish-verification', payload)
          continue
        }
        if (state.outer.phase === 'verify' && decision.action === 'finalize') {
          if (!state.candidate || !state.verification?.approval || state.verification.verdict !== 'pass') throw new ContractError('INVALID_ACTION', ['finalize requires approved passing verification'])
          const referenced = [state.candidate.file_manifest, state.candidate.diff, state.candidate.review?.report, ...state.verification.checks.map((check) => check.report)].filter((item) => item !== null && item !== undefined)
          for (const artifact of referenced) await this.evidence.read(artifact)
          const verification = await this.evidence.writeNamed('verification.md', `# 验证报告\n\n候选：${state.candidate.candidate_id}\n\n结论：${state.verification.verdict}\n\n${state.verification.acceptance.map((item) => `- ${item.id}: ${item.result} - ${item.reason}`).join('\n')}\n`)
          const delivery = await this.evidence.writeNamed('delivery-summary.json', `${JSON.stringify({ change_id: state.change_id, candidate_id: state.candidate.candidate_id, candidate_digest: state.candidate.candidate_digest, summary: state.candidate.summary, known_limits: state.candidate.known_limits }, null, 2)}\n`)
          const knowledge = await this.evidence.writeNamed('knowledge.md', `# ${state.title}\n\n${state.candidate.summary}\n\n候选摘要：${state.candidate.candidate_digest}\n`)
          const artifactIndex = await this.evidence.writeNamed('artifact-index.json', `${JSON.stringify({ schema: 'phixlin.artifact-index.v1', artifacts: referenced }, null, 2)}\n`)
          const archive = await this.evidence.write(JSON.stringify({ schema: 'phixlin.archive.v1', change_id: state.change_id, workflow: state.workflow, candidate: state.candidate, verification: state.verification, history: state.history, artifacts: [verification, delivery, knowledge, artifactIndex, ...referenced] }))
          state = await this.mutate(changeId, state, 'finalize', { candidate_id: state.candidate.candidate_id, artifacts: [archive, verification, delivery, knowledge, artifactIndex] })
          continue
        }
        return { state, decision, steps }
      }
      if (!dispatch) return { state, decision, steps }
      const operationId = `operation-${randomUUID()}`
      if (!(await this.candidateIntact(state))) {
        state = await this.mutate(changeId, state, 'candidate-drift', {})
        continue
      }
      const executionRef = `execution-${randomUUID()}`
      const position = 'position' in state.inner ? state.inner.position : undefined
      const skillInput = position === undefined ? undefined : await this.skillInput(state, position)
      state = await this.mutate(changeId, state, 'reserve-operation', {
        operation_id: operationId,
        execution_ref: executionRef,
        input_digest: skillInput === undefined ? state.stage_context.binding.input_digest : digestJson(skillInput),
        workspace_before: state.candidate?.candidate_digest ?? state.workspace.baseline.sha256,
      })
      const skillName = position?.action === 'skill' && position.skill_index !== null && state.outer.phase !== 'completed'
        ? state.workflow.stages[state.outer.phase][position.skill_index]?.name
        : undefined
      const result = await this.runtime.execute({ operationId, executionRef, state, action: position?.action ?? decision.action, skillName, skillInput })
      for (const artifact of result.artifacts) await this.evidence.read(artifact)
      for (const artifact of result.shape?.documents ?? []) await this.evidence.read(artifact)
      if (result.candidate) {
        await this.evidence.read(result.candidate.file_manifest)
        await this.evidence.read(result.candidate.diff)
      }
      if (result.review) await this.evidence.read(result.review.report)
      for (const check of result.checks ?? []) if (check.report) await this.evidence.read(check.report)
      for (const invocation of result.skill_invocations ?? []) if (invocation.artifact) await this.evidence.read(invocation.artifact)
      const raw_output = await this.evidence.write(JSON.stringify(result))
      if (state.inner.state !== 'executing') throw new ContractError('INVALID_ACTION', ['dispatch reservation is missing'])
      const collected = await this.evidence.write(JSON.stringify({ operation: state.inner.operation, result: { ...result, raw_output } }))
      state = await this.mutate(changeId, state, 'execution-result', {
        operation_id: operationId,
        result: collected,
      })
    }
    if (maxSteps === 100) throw new ContractError('INVALID_ACTION', ['stage runner exceeded 100 steps'])
    state = await this.store.read(changeId)
    return { state, decision: decide(state), steps: maxSteps }
  }

  async prepare(changeId: string): Promise<{ state: ChangeState; input: string | null }> {
    const { state, decision } = await this.drive(changeId, 100, false)
    if (decision.kind === 'wait' && decision.reason === 'executing') {
      if (state.inner.state !== 'executing') throw new ContractError('INVALID_ACTION', ['operation not executing'])
      const input = await this.skillInput(state, state.inner.position)
      if (digestJson(input) !== state.inner.operation.binding.input_digest) throw new ContractError('RESOURCE_DRIFT', ['operation input changed after reservation'])
      return { state, input }
    }
    if (decision.kind !== 'dispatch') return { state, input: null }
    if (!(await this.candidateIntact(state))) {
      await this.mutate(changeId, state, 'candidate-drift', {})
      return this.prepare(changeId)
    }
    const position = state.inner.state === 'ready' ? state.inner.position : null
    if (!position) throw new ContractError('INVALID_ACTION', ['dispatch requires ready state'])
    const input = await this.skillInput(state, position)
    const reserved = await this.mutate(changeId, state, 'reserve-operation', {
      operation_id: `operation-${randomUUID()}`,
      execution_ref: `execution-${randomUUID()}`,
      input_digest: digestJson(input),
      workspace_before: state.candidate?.candidate_digest ?? state.workspace.baseline.sha256,
    })
    if (position.action === 'run-checks') {
      if (reserved.inner.state !== 'executing') throw new ContractError('INVALID_ACTION', ['machine check reservation missing'])
      let result: RuntimeResult
      try { result = await this.runtime.execute({ operationId: reserved.inner.operation.operation_id, executionRef: reserved.inner.operation.execution_ref, state: reserved, action: 'run-checks', skillInput: input }) }
      catch (error) {
        const failed = await this.mutate(changeId, reserved, 'execution-error', { operation_id: reserved.inner.operation.operation_id, confirmed_stopped: true, reason: String(error), manual_retry: true })
        return { state: failed, input: null }
      }
      await this.submit(changeId, reserved, result)
      return this.prepare(changeId)
    }
    return { state: reserved, input }
  }

  async submit(changeId: string, state: ChangeState, result: RuntimeResult): Promise<ChangeState> {
    if (state.inner.state !== 'executing') throw new ContractError('INVALID_ACTION', ['operation not executing'])
    const operation = state.inner.operation
    if (digestJson(await this.skillInput(state, state.inner.position)) !== operation.binding.input_digest) throw new ContractError('RESOURCE_DRIFT', ['operation input changed after reservation'])
    validateExecutionResult({ schema: 'phixlin.execution-result.v1', binding: { change_id: state.change_id, stage_visit: state.outer.stage_visit, input_digest: operation.binding.input_digest }, kind: result.kind, summary: result.summary, artifacts: result.artifacts, questions: result.questions, proposal: result.proposal, skill_invocations: result.skill_invocations ?? [] })
    if (state.inner.position.action === 'agent-work' && state.outer.phase === 'shape' && result.kind === 'stage-ready' && result.shape) validateShapeContent(result.shape)
    for (const artifact of result.artifacts) await this.evidence.read(artifact)
    for (const artifact of result.shape?.documents ?? []) await this.evidence.read(artifact)
    if (result.candidate) {
      await this.evidence.read(result.candidate.file_manifest)
      await this.evidence.read(result.candidate.diff)
    }
    if (result.review) await this.evidence.read(result.review.report)
    for (const check of result.checks ?? []) if (check.report) await this.evidence.read(check.report)
    for (const invocation of result.skill_invocations ?? []) if (invocation.artifact) await this.evidence.read(invocation.artifact)
    const raw_output = await this.evidence.write(JSON.stringify(result))
    const collected = await this.evidence.write(JSON.stringify({ operation, result: { ...result, raw_output } }))
    return this.mutate(changeId, state, 'execution-result', { operation_id: operation.operation_id, result: collected })
  }
}
