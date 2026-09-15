import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { ContractError, FileStateMutationStore, digestJson } from '../../src/index.js'

describe('file CAS store', () => {
  it('deduplicates action IDs and rejects stale versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-cas-'))
    await mkdir(join(root, 'change'))
    await cp('fixtures/state/initial.yaml', join(root, 'change/flow-state.yaml'))
    const store = new FileStateMutationStore(root)
    const request = { expectedVersion: 0, actionId: 'reserve-1', action: 'reserve-operation', payload: { operation_id: 'op-1', execution_ref: 'exec-1' } }
    expect((await store.mutate('change', request)).replayed).toBe(false)
    expect((await store.mutate('change', request)).replayed).toBe(true)
    await expect(store.mutate('change', { ...request, actionId: 'other' })).rejects.toThrowError(expect.objectContaining<Partial<ContractError>>({ code: 'VERSION_CONFLICT' }))
  })

  it('serializes concurrent writers so only one wins the expected version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-cas-'))
    await mkdir(join(root, 'change'))
    await cp('fixtures/state/initial.yaml', join(root, 'change/flow-state.yaml'))
    const store = new FileStateMutationStore(root)
    const request = (id: string) => ({ expectedVersion: 0, actionId: id, action: 'reserve-operation', payload: { operation_id: `op-${id}`, execution_ref: `exec-${id}` } })
    const results = await Promise.allSettled([store.mutate('change', request('a')), store.mutate('change', request('b'))])
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect((await store.read('change')).state_version).toBe(1)
    expect((await readFile(join(root, 'change/flow-state.yaml'), 'utf8')).startsWith('schema:')).toBe(true)
  })

  it('rejects state content changed outside the Store without a version increment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-cas-'))
    await mkdir(join(root, 'change'))
    await cp('fixtures/state/initial.yaml', join(root, 'change/flow-state.yaml'))
    const store = new FileStateMutationStore(root)
    const state = await store.read('change')
    const expectedStateDigest = digestJson(state)
    state.title = 'tampered by external process'
    await writeFile(join(root, 'change/flow-state.yaml'), stringify(state))
    await expect(store.mutate('change', { expectedVersion: 0, expectedStateDigest, actionId: 'reserve', action: 'reserve-operation', payload: { operation_id: 'op', execution_ref: 'exec' } })).rejects.toThrow('state content changed without a version increment')
  })
})
