import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ContractError,
  decide,
  parseChangeStateYaml,
  validateChangeState,
  type Action,
  type ArtifactRef,
  type ChangeState,
  type LoopPosition,
  type Operation,
} from '../../src/index.js'

const digest = 'a'.repeat(64)
const evidence: ArtifactRef = { path: 'artifacts/evidence.json', sha256: digest, bytes: 2 }

function fixture(name: 'initial' | 'build' | 'verify' | 'completed' = 'verify'): ChangeState {
  return parseChangeStateYaml(readFileSync(`fixtures/state/${name}.yaml`, 'utf8'))
}

function position(action: Action, skillIndex: number | null = null): LoopPosition {
  return { action, skill_index: skillIndex, turn: 1, attempt: 1 }
}

function operation(state: ChangeState, action: Action): Operation {
  return {
    operation_id: 'operation-current',
    execution_ref: 'execution-current',
    binding: structuredClone(state.stage_context.binding),
    action,
    attempt: 1,
    reserved_at: '2026-09-11T08:20:00Z',
    process: null,
  }
}

function makeBlocked(state: ChangeState): void {
  const resume = { state: 'ready' as const, position: position('agent-work') }
  state.outer.status = 'blocked'
  state.inner = { state: 'blocked', position: position('agent-work'), blocker_id: 'blocker-1' }
  state.interaction = null
  state.blocker = {
    id: 'blocker-1',
    code: 'EXECUTION_UNKNOWN',
    reason: 'External execution outcome is unknown.',
    allowed_actions: ['adopt-result', 'retry'],
    resume,
  }
}

function completeInitialSkill(state: ChangeState): void {
  const skill = state.skills[0]
  skill.status = 'completed'
  skill.attempts = 1
  skill.input_digest = digest
  skill.raw_output = evidence
  skill.workspace_before = digest
  skill.workspace_after = digest
  skill.completed_by = 'execution-skill-1'
  state.stage_context.planned_completed = [skill.name]
  state.stage_context.execution_records = [skill.invocation_id]
}

function expectIssue(
  name: 'initial' | 'build' | 'verify' | 'completed',
  mutate: (state: ChangeState) => void,
  issue: string,
): void {
  const state = fixture(name)
  mutate(state)
  expect(() => validateChangeState(state)).toThrowError(
    expect.objectContaining<Partial<ContractError>>({
      code: 'INVALID_STATE',
      message: expect.stringContaining(issue),
    }),
  )
}

describe('valid lifecycle decisions', () => {
  it('waits while paused', () => {
    const state = fixture('build')
    state.outer.status = 'paused'
    expect(validateChangeState(state)).toBe(state)
    expect(decide(state)).toEqual({ kind: 'wait', reason: 'paused' })
  })

  it('waits while blocked', () => {
    const state = fixture('build')
    makeBlocked(state)
    expect(validateChangeState(state)).toBe(state)
    expect(decide(state)).toEqual({ kind: 'wait', reason: 'blocked' })
  })

  it('waits for an executing operation', () => {
    const state = fixture('initial')
    const currentPosition = position('skill', 0)
    state.inner = {
      state: 'executing',
      position: currentPosition,
      operation: operation(state, 'skill'),
    }
    state.skills[0].status = 'running'
    state.skills[0].attempts = 1
    state.skills[0].input_digest = digest
    state.skills[0].workspace_before = digest
    expect(validateChangeState(state)).toBe(state)
    expect(decide(state)).toEqual({ kind: 'wait', reason: 'executing' })
  })

  it('reconciles an operation whose outcome is unknown', () => {
    const state = fixture('build')
    state.inner = {
      state: 'reconciling',
      position: position('agent-work'),
      operation: operation(state, 'agent-work'),
    }
    expect(validateChangeState(state)).toBe(state)
    expect(decide(state)).toEqual({ kind: 'reconcile', operation_id: 'operation-current' })
  })

  it('evaluates a collected result', () => {
    const state = fixture('build')
    state.inner = {
      state: 'evaluating',
      position: position('agent-work'),
      operation: operation(state, 'agent-work'),
      result: evidence,
    }
    expect(validateChangeState(state)).toBe(state)
    expect(decide(state)).toEqual({ kind: 'evaluate', operation_id: 'operation-current' })
  })

  it.each([
    ['shape', 'initial', 'agent-work'],
    ['build', 'build', 'agent-work'],
    ['verify', 'verify', 'verify-candidate'],
  ] as const)('advances a %s result using its originating action', (_phase, name, action) => {
    const state = fixture(name)
    if (name === 'initial') completeInitialSkill(state)
    if (name === 'verify') {
      state.outer.status = 'active'
      state.interaction = null
    }
    state.inner = { state: 'stage-ready', position: position(action), evidence: [evidence] }
    expect(validateChangeState(state)).toBe(state)
    expect(decide(state)).toEqual({ kind: 'advance', action })
  })

  it('keeps a paused question and its resume position', () => {
    const state = fixture('verify')
    state.outer.status = 'paused'
    expect(validateChangeState(state)).toBe(state)
    expect(decide(state)).toEqual({ kind: 'wait', reason: 'paused' })
  })
})

describe('outer and inner invariants', () => {
  it.each([
    ['completed gate', 'completed', (state: ChangeState) => { state.outer.status = 'active' }, 'completed phase requires outer done and inner idle'],
    ['done before completion', 'build', (state: ChangeState) => { state.outer.status = 'done' }, 'done status requires completed phase'],
    ['idle before completion', 'build', (state: ChangeState) => { state.inner = { state: 'idle' } }, 'inner idle requires completed phase'],
    ['await-user lifecycle', 'build', (state: ChangeState) => { state.outer.status = 'await-user' }, 'await-user requires waiting-user inner state and interaction'],
    ['active side record', 'verify', (state: ChangeState) => { state.outer.status = 'active' }, 'active status cannot retain interaction or blocker'],
    ['waiting interaction id', 'verify', (state: ChangeState) => { if (state.interaction) state.interaction.id = 'other' }, 'waiting-user interaction_id does not match interaction'],
    ['phase action', 'build', (state: ChangeState) => { if ('position' in state.inner) state.inner.position.action = 'run-checks' }, 'action run-checks is not valid in build'],
    ['non-Skill index', 'build', (state: ChangeState) => { if ('position' in state.inner) state.inner.position.skill_index = 0 }, 'skill_index must be set exactly when action is skill'],
  ] as const)('rejects %s', (_case, name, mutate, issue) => {
    expectIssue(name, mutate, issue)
  })

  it('rejects a blocker attached to await-user', () => {
    expectIssue('verify', (state) => {
      state.blocker = {
        id: 'blocker-1',
        code: 'OTHER',
        reason: 'Not compatible with await-user.',
        allowed_actions: ['retry'],
        resume: { state: 'ready', position: position('finalize') },
      }
    }, 'await-user cannot retain blocker')
  })

  it('rejects blocked status without a matching blocked lifecycle', () => {
    expectIssue('build', (state) => {
      state.outer.status = 'blocked'
    }, 'blocked status requires blocked inner state and blocker')
  })

  it('rejects an interaction retained beside a blocker', () => {
    expectIssue('verify', (state) => {
      makeBlocked(state)
      state.interaction = {
        id: 'question-1',
        kind: 'question',
        binding: structuredClone(state.stage_context.binding),
        questions: ['Continue?'],
        answers: [],
        resume: { state: 'ready', position: position('verify-candidate') },
      }
    }, 'blocked status cannot retain interaction')
  })

  it('rejects state records retained after completion', () => {
    expectIssue('completed', (state) => {
      state.blocker = {
        id: 'blocker-1',
        code: 'OTHER',
        reason: 'Completed changes cannot remain blocked.',
        allowed_actions: ['inspect'],
        resume: { state: 'ready', position: position('finalize') },
      }
    }, 'done status cannot retain interaction or blocker')
  })

  it('rejects paused idle state', () => {
    expectIssue('completed', (state) => {
      state.outer.status = 'paused'
    }, 'paused status cannot combine with inner idle')
  })

  it('rejects a paused question without its interaction', () => {
    expectIssue('verify', (state) => {
      state.outer.status = 'paused'
      state.interaction = null
    }, 'paused waiting-user state requires interaction')
  })

  it('rejects a blocker ID mismatch', () => {
    expectIssue('build', (state) => {
      makeBlocked(state)
      if (state.blocker) state.blocker.id = 'other-blocker'
    }, 'blocked blocker_id does not match blocker')
  })
})

describe('operation and interaction bindings', () => {
  it('rejects a stale stage context', () => {
    expectIssue('build', (state) => {
      state.stage_context.binding.stage_visit = 1
    }, 'stage_context binding is stale')
  })

  it('rejects an operation with a stale binding', () => {
    expectIssue('build', (state) => {
      const currentOperation = operation(state, 'agent-work')
      currentOperation.binding.brief_revision = 2
      state.inner = {
        state: 'executing',
        position: position('agent-work'),
        operation: currentOperation,
      }
    }, 'operation binding does not match stage_context')
  })

  it('rejects an operation for a different action', () => {
    expectIssue('build', (state) => {
      state.inner = {
        state: 'executing',
        position: position('agent-work'),
        operation: operation(state, 'capture-candidate'),
      }
    }, 'operation action does not match inner position')
  })

  it('rejects a stale interaction binding', () => {
    expectIssue('verify', (state) => {
      if (state.interaction) state.interaction.binding.input_digest = digest
    }, 'interaction binding does not match stage_context')
  })
})

describe('Skill execution invariants', () => {
  it.each([
    ['duplicate snapshot', (state: ChangeState) => { state.workflow.stages.shape.push(structuredClone(state.workflow.stages.shape[0])) }, 'workflow shape stage contains duplicate skills'],
    ['duplicate invocation', (state: ChangeState) => { state.skills.push(structuredClone(state.skills[0])) }, 'duplicate skill invocation_id'],
    ['planned index absent', (state: ChangeState) => { state.skills[0].index = null }, 'planned skill local-shape has no index'],
    ['snapshot mismatch', (state: ChangeState) => { state.skills[0].source_digest = digest }, 'does not match workflow index 0'],
    ['reported planned Skill', (state: ChangeState) => { state.skills[0].observation = 'model-reported' }, 'must be host-observed'],
    ['pending output', (state: ChangeState) => { state.skills[0].attempts = 1 }, 'pending skill local-shape contains execution output'],
    ['missing record', (state: ChangeState) => { state.skills = [] }, 'current visit must contain all 1 planned skill records'],
    ['completion summary drift', (state: ChangeState) => { state.stage_context.planned_completed = ['local-shape'] }, 'planned_completed does not match'],
    ['unknown execution record', (state: ChangeState) => { state.stage_context.execution_records = ['unknown'] }, 'references unknown execution record'],
  ] as const)('rejects %s', (_case, mutate, issue) => {
    expectIssue('initial', mutate, issue)
  })

  it('rejects a contextual Skill with a planned index', () => {
    expectIssue('initial', (state) => {
      const contextual = structuredClone(state.skills[0])
      contextual.invocation_id = 'contextual-1'
      contextual.mode = 'contextual'
      state.skills.push(contextual)
    }, 'contextual skill local-shape cannot have a planned index')
  })

  it('rejects completed Skill state without immutable evidence', () => {
    expectIssue('initial', (state) => {
      state.skills[0].status = 'completed'
    }, 'completed skill local-shape lacks execution evidence')
  })

  it('rejects a Skill pointer that targets a completed record', () => {
    expectIssue('initial', (state) => {
      completeInitialSkill(state)
    }, 'skill position 0 is not pending or failed')
  })

  it('rejects skipping an earlier incomplete planned Skill', () => {
    expectIssue('initial', (state) => {
      state.workflow.stages.shape.push({
        name: 'second-shape',
        path: '.agents/skills/second-shape/SKILL.md',
        digest,
        resources: [],
        source_commit: null,
      })
      const second = structuredClone(state.skills[0])
      second.invocation_id = 'shape-visit-1-skill-1'
      second.index = 1
      second.name = 'second-shape'
      second.source_digest = digest
      state.skills.push(second)
      if ('position' in state.inner) state.inner.position.skill_index = 1
    }, 'skill position skips an incomplete planned skill')
  })

  it('rejects stage readiness while a planned Skill remains incomplete', () => {
    expectIssue('initial', (state) => {
      state.inner = { state: 'stage-ready', position: position('agent-work'), evidence: [evidence] }
    }, 'stage-ready requires every planned skill to be completed')
  })
})
