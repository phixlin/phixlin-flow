import type { Decision, ChangeState } from './types.js'

export function decide(state: ChangeState): Decision {
  if (state.outer.status === 'done') return { kind: 'done' }
  if (state.outer.status === 'paused') return { kind: 'wait', reason: 'paused' }
  if (state.outer.status === 'await-user') return { kind: 'wait', reason: 'await-user' }
  if (state.outer.status === 'blocked') return { kind: 'wait', reason: 'blocked' }

  switch (state.inner.state) {
    case 'ready':
      return {
        kind: 'dispatch',
        action: state.inner.position.action,
        skill_index: state.inner.position.skill_index,
      }
    case 'executing':
      return { kind: 'wait', reason: 'executing' }
    case 'reconciling':
      return { kind: 'reconcile', operation_id: state.inner.operation.operation_id }
    case 'evaluating':
      return { kind: 'evaluate', operation_id: state.inner.operation.operation_id }
    case 'stage-ready':
      return { kind: 'advance', action: state.inner.position.action }
    case 'idle':
    case 'waiting-user':
    case 'blocked':
      throw new Error(`validated active state cannot have inner state ${state.inner.state}`)
  }
}
