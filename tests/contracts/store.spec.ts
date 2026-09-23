import { cp, mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { ContractError, FileEvidenceStore, FileStateMutationStore, digestJson, parseChangeStateYaml } from '../../src/index.js'

describe('file CAS store', () => {
  it('固定使用 mutation.lock，并忽略 Windows 锁目录清理竞争', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-cas-'))
    await mkdir(join(root, 'change'))
    await cp('fixtures/state/initial.yaml', join(root, 'change/flow-state.yaml'))
    let options: import('proper-lockfile').LockOptions | undefined
    const acquire = async (_file: string, received: import('proper-lockfile').LockOptions) => {
      options = received
      return async () => { throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }) }
    }
    const store = new FileStateMutationStore(root, 10_000, acquire)
    await expect(store.mutate('change', { expectedVersion: 0, actionId: 'windows-cleanup', action: 'reserve-operation', payload: { operation_id: 'op', execution_ref: 'exec' } })).resolves.toMatchObject({ replayed: false })
    expect(options?.lockfilePath).toBe(join(root, 'change', 'mutation.lock'))
    expect((await store.read('change')).state_version).toBe(1)
  })

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

  it('下一次加锁时清理上一次原子替换失败留下的临时状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-cas-'))
    await mkdir(join(root, 'change'))
    await cp('fixtures/state/initial.yaml', join(root, 'change/flow-state.yaml'))
    const failingStore = new FileStateMutationStore(root, 10_000, undefined, async () => {
      throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
    })
    await expect(failingStore.mutate('change', { expectedVersion: 0, actionId: 'failed-replace', action: 'reserve-operation', payload: { operation_id: 'op', execution_ref: 'exec' } })).rejects.toMatchObject({ code: 'EPERM' })
    expect((await readdir(join(root, 'change'))).some((entry) => entry.endsWith('.tmp'))).toBe(true)

    const recovered = new FileStateMutationStore(root)
    await recovered.mutate('change', { expectedVersion: 0, actionId: 'recovered', action: 'reserve-operation', payload: { operation_id: 'op-2', execution_ref: 'exec-2' } })
    expect((await readdir(join(root, 'change'))).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    expect((await recovered.read('change')).state_version).toBe(1)
  })

  it('清理旧版本遗留的过期 mutation.lock.lock 目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-cas-'))
    const changeRoot = join(root, 'change')
    await mkdir(changeRoot)
    await cp('fixtures/state/initial.yaml', join(changeRoot, 'flow-state.yaml'))
    const legacyLock = join(changeRoot, 'mutation.lock.lock')
    await mkdir(legacyLock)
    const stale = new Date(Date.now() - 60_000)
    await utimes(legacyLock, stale, stale)
    await new FileStateMutationStore(root).mutate('change', { expectedVersion: 0, actionId: 'legacy-lock', action: 'reserve-operation', payload: { operation_id: 'op', execution_ref: 'exec' } })
    await expect(readdir(changeRoot)).resolves.not.toContain('mutation.lock.lock')
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

  it('创建新状态并拒绝 actionId 对应不同 payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-cas-'))
    const initial = parseChangeStateYaml(await readFile('fixtures/state/initial.yaml', 'utf8'))
    initial.change_id = 'created'
    initial.stage_context.binding.change_id = 'created'
    const store = new FileStateMutationStore(root)
    await store.create(initial)
    expect((await store.read('created')).change_id).toBe('created')
    const request = { expectedVersion: 0, actionId: 'same', action: 'reserve-operation', payload: { operation_id: 'op-1', execution_ref: 'exec-1' } }
    await store.mutate('created', request)
    await expect(store.mutate('created', { ...request, payload: { operation_id: 'op-2', execution_ref: 'exec-2' } })).rejects.toMatchObject({ code: 'ACTION_CONFLICT' })
  })
})

describe('证据存储边界', () => {
  it('拒绝非规范路径、长度漂移和摘要漂移', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phixlin-evidence-store-'))
    const store = new FileEvidenceStore(root)
    const artifact = await store.write('content')
    await expect(store.read({ ...artifact, path: 'outside.json' })).rejects.toMatchObject({ code: 'INVALID_EXECUTION_RESULT' })
    await expect(store.read({ ...artifact, path: 'artifacts/../outside.json' })).rejects.toMatchObject({ code: 'INVALID_EXECUTION_RESULT' })
    await expect(store.read({ ...artifact, path: 'artifacts/a\\b' })).rejects.toMatchObject({ code: 'INVALID_EXECUTION_RESULT' })
    await expect(store.read({ ...artifact, bytes: artifact.bytes + 1 })).rejects.toMatchObject({ code: 'RESOURCE_DRIFT' })
    await expect(store.read({ ...artifact, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'RESOURCE_DRIFT' })
    await expect(store.write('content')).resolves.toEqual(artifact)
  })
})
