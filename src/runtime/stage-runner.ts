import { randomUUID } from 'node:crypto'
import { ContractError } from '../contracts/error.js'
import { decide } from '../contracts/decide.js'
import type { ChangeState, Decision, MutationReceipt, MutationRequest } from '../contracts/types.js'
import type { RuntimeAdapter } from './fake.js'

export interface StageRunnerOptions {
  maxSteps?: number
  idFactory?: () => string
}

export type DriveResult = { state: ChangeState; decision: Decision; steps: number }
export interface MutationPort {
  read(changeId: string): Promise<ChangeState>
  mutate(changeId: string, request: MutationRequest<string, Record<string, unknown>>): Promise<MutationReceipt>
}

/** Drives controller-owned mutations; external runtime calls happen outside the CAS lock. */
export class StageRunner {
  private readonly maxSteps: number
  private readonly idFactory: () => string

  constructor(
    private readonly store: MutationPort,
    private readonly runtime: RuntimeAdapter,
    options: StageRunnerOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 100
    this.idFactory = options.idFactory ?? randomUUID
  }

  private async mutate(changeId: string, state: ChangeState, action: string, payload: Record<string, unknown>): Promise<ChangeState> {
    const request: MutationRequest<string, Record<string, unknown>> = { expectedVersion: state.state_version, actionId: this.idFactory(), action, payload }
    await this.store.mutate(changeId, request)
    return this.store.read(changeId)
  }

  private async evaluate(changeId: string, state: ChangeState): Promise<ChangeState> {
    if (state.inner.state !== 'evaluating') throw new ContractError('INVALID_ACTION', ['evaluate requires evaluating state'])
    if (!('operation' in state.inner) || !('position' in state.inner)) throw new ContractError('INVALID_ACTION', ['evaluate requires operation position'])
    const currentPosition = state.inner.position
    const operationId = state.inner.operation.operation_id
    const result = this.runtime.result?.(operationId)
    if (result === undefined) throw new ContractError('EXECUTION_UNKNOWN', [`no persisted result for ${operationId}`])
    const payload: Record<string, unknown> = { operation_id: operationId }
    if (result.kind === 'needs-user') {
      payload.interaction_id = `interaction-${operationId}`
      payload.questions = result.questions
      return this.mutate(changeId, state, 'result-needs-user', payload)
    }
    if (result.kind === 'blocked') {
      return this.mutate(changeId, state, 'execution-error', { operation_id: operationId, confirmed_stopped: true, reason: result.summary })
    }
    if (currentPosition.action === 'skill') {
      const skill = state.skills.find((item) => item.mode === 'planned' && item.index === currentPosition.skill_index)
      if (skill === undefined) throw new ContractError('INVALID_ACTION', ['planned skill record is missing'])
      return this.mutate(changeId, state, 'skill-completed', {
        operation_id: operationId,
        invocation_id: skill.invocation_id,
        raw_output: result.raw_output,
        artifacts: result.artifacts,
      })
    }
    if (result.kind === 'stage-ready') {
      return this.mutate(changeId, state, 'result-stage-ready', { operation_id: operationId, evidence: result.artifacts.length > 0 ? result.artifacts : [result.raw_output] })
    }
    return this.mutate(changeId, state, 'result-continue', { operation_id: operationId })
  }

  async drive(changeId: string): Promise<DriveResult> {
    let state = await this.store.read(changeId)
    let steps = 0
    while (steps++ < this.maxSteps) {
      const decision = decide(state)
      if (decision.kind === 'wait' || decision.kind === 'done') return { state, decision, steps }
      if (decision.kind === 'reconcile') return { state, decision, steps }
      if (decision.kind === 'evaluate') {
        state = await this.evaluate(changeId, state)
        continue
      }
      if (decision.kind === 'advance') return { state, decision, steps }
      const operationId = `operation-${this.idFactory()}`
      const executionRef = `execution-${this.idFactory()}`
      state = await this.mutate(changeId, state, 'reserve-operation', {
        operation_id: operationId,
        execution_ref: executionRef,
        input_digest: state.stage_context.binding.input_digest,
      })
      const position = 'position' in state.inner ? state.inner.position : undefined
      const skillName = position?.action === 'skill' && position.skill_index !== null && state.outer.phase !== 'completed'
        ? state.workflow.stages[state.outer.phase][position.skill_index]?.name
        : undefined
      const result = await this.runtime.execute({ operationId, executionRef, state, action: position?.action ?? decision.action, skillName })
      state = await this.mutate(changeId, state, 'execution-result', {
        operation_id: operationId,
        result: result.raw_output ?? { path: `artifacts/${operationId}-output.json`, sha256: '0'.repeat(64), bytes: 0 },
      })
    }
    throw new ContractError('INVALID_ACTION', [`stage runner exceeded ${this.maxSteps} steps`])
  }
}
