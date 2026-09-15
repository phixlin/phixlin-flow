import { decide } from '../contracts/decide.js'
import type { ChangeState } from '../contracts/types.js'

export function getNextAction(state: ChangeState): string {
  const decision = decide(state)
  if (decision.kind === 'dispatch' || decision.kind === 'advance') return decision.action
  if (decision.kind === 'wait' && decision.reason === 'paused') return 'paused'
  if (decision.kind === 'wait' && state.interaction) return state.interaction.kind
  return decision.kind === 'wait' ? decision.reason : decision.kind
}

function nextCommand(state: ChangeState, action: string): string | null {
  const expected = `--expected-version ${state.state_version} --expected-action ${action}`
  if (action === 'shape-approval') return `phixlin-flow confirm-shape ${state.change_id} --actor <actor> ${expected}`
  if (action === 'result-approval') return `phixlin-flow accept-result ${state.change_id} --actor <actor> ${expected}`
  if (action === 'question') return `phixlin-flow answer ${state.change_id} --interaction ${state.interaction?.id ?? '<interaction-id>'} --body-file <answer-file> ${expected}`
  if (action === 'paused') return `phixlin-flow resume ${state.change_id} ${expected}`
  if (action === 'blocked') return state.blocker?.allowed_actions.includes('retry') ? `phixlin-flow retry ${state.change_id} ${expected}` : null
  if (action === 'done') return null
  return `phixlin-flow resume ${state.change_id} ${expected}`
}

export function buildStatus(state: ChangeState, recentLimit = 5) {
  const action = getNextAction(state)
  const planned = state.skills.filter((skill) => skill.mode === 'planned')
  return {
    change_id: state.change_id,
    state_version: state.state_version,
    phase: state.outer.phase,
    status: state.outer.status,
    stage_visit: state.outer.stage_visit,
    iteration: state.outer.iteration,
    loop: { state: state.inner.state, position: 'position' in state.inner ? state.inner.position : null },
    skills: {
      completed: planned.filter((skill) => skill.status === 'completed').length,
      total: planned.length,
      items: state.skills.map(({ invocation_id, mode, index, name, status, attempts }) => ({ invocation_id, mode, index, name, status, attempts })),
    },
    requires_user: ['await-user', 'blocked', 'paused'].includes(state.outer.status),
    interaction: state.interaction,
    blocker: state.blocker ? { ...state.blocker, recovery_command: nextCommand(state, action) } : null,
    recent_events: state.history.slice(-recentLimit),
    next_action: action,
    next_command: nextCommand(state, action),
    budget: state.budget,
  }
}
