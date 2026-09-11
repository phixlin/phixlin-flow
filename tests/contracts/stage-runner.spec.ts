import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FakeRuntime, StageRunner, parseChangeStateYaml, reduce, type ChangeState, type MutationReceipt, type MutationRequest } from '../../src/index.js'

class MemoryStore {
  constructor(private state: ChangeState) {}
  async read(): Promise<ChangeState> { return structuredClone(this.state) }
  async mutate(_changeId: string, request: MutationRequest<string, Record<string, unknown>>): Promise<MutationReceipt> {
    this.state = reduce(this.state, { type: request.action, actionId: request.actionId, payload: request.payload })
    return { actionId: request.actionId, payloadDigest: '', previousVersion: request.expectedVersion, stateVersion: this.state.state_version, replayed: false }
  }
}

const load = (name: string): ChangeState => parseChangeStateYaml(readFileSync(`fixtures/state/${name}.yaml`, 'utf8'))

describe('M1 stage runner', () => {
  it('runs a Build turn through reserve, runtime, collect, and stage-ready', async () => {
    const store = new MemoryStore(load('build'))
    const runtime = new FakeRuntime([{ kind: 'stage-ready', summary: 'candidate ready', artifacts: [{ path: 'artifacts/build-handoff.json', sha256: '0'.repeat(64), bytes: 1 }], questions: [], proposal: null }])
    const runner = new StageRunner(store, runtime, { idFactory: (() => { let i = 0; return () => `id-${++i}` })() })
    const result = await runner.drive('m0-example')
    expect(result.decision).toEqual({ kind: 'advance', action: 'agent-work' })
    expect(result.state.inner.state).toBe('stage-ready')
    expect(runtime.calls).toHaveLength(1)
  })
})
