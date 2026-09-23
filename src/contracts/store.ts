import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { parse, stringify } from 'yaml'
import { digestJson } from './digest.js'
import { ContractError } from './error.js'
import { reduce, type ReducerEvent } from './reducer.js'
import { validateChangeState } from './validation.js'
import type { ChangeState, MutationReceipt, MutationRequest, StateMutationStore } from './types.js'
import type { LockOptions } from 'proper-lockfile'

type AcquireLock = (file: string, options: LockOptions) => Promise<() => Promise<void>>
type ReplaceFile = (source: string, target: string) => Promise<void>

const windowsRetryCodes = new Set(['EACCES', 'EBUSY', 'EPERM'])

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function retryWindowsOperation(operation: () => Promise<void>, operationName: string, attempts = 5): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation()
      return
    } catch (error: unknown) {
      lastError = error
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (process.platform !== 'win32' || !windowsRetryCodes.has(code ?? '') || attempt === attempts - 1) throw error
      await delay(25 * (attempt + 1))
    }
  }
  throw new Error(`${operationName} failed`, { cause: lastError })
}

/** File-backed CAS store. Cross-process exclusion uses a bounded, stale-recoverable lock. */
export class FileStateMutationStore implements StateMutationStore {
  constructor(
    private readonly root: string,
    private readonly lockTimeoutMs = 10_000,
    private readonly acquireLock: AcquireLock = lockfile.lock,
    private readonly replaceFile: ReplaceFile = fs.rename,
  ) {}

  private statePath(changeId: string): string { return join(this.root, changeId, 'flow-state.yaml') }
  private lockPath(changeId: string): string { return join(this.root, changeId, 'mutation.lock') }

  private async withLock<T>(changeId: string, fn: () => Promise<T>): Promise<T> {
    const path = this.statePath(changeId)
    const lockPath = this.lockPath(changeId)
    await fs.mkdir(dirname(path), { recursive: true })
    let release: () => Promise<void>
    try {
      release = await this.acquireLock(path, {
        lockfilePath: lockPath,
        retries: { retries: Math.max(0, Math.floor(this.lockTimeoutMs / 10)), minTimeout: 10, maxTimeout: 10 },
        stale: Math.max(2_000, this.lockTimeoutMs * 3),
        update: Math.max(1_000, this.lockTimeoutMs),
        realpath: false,
      })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ELOCKED') throw new ContractError('LOCK_BUSY', ['mutation lock timeout'])
      throw error
    }
    let result: T
    try {
      await this.cleanupLegacyLock(dirname(path))
      await this.cleanupTemporaryStates(dirname(path))
      result = await fn()
    } catch (error) {
      try { await release() }
      catch (releaseError) {
        const code = (releaseError as NodeJS.ErrnoException | null)?.code
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '')) throw releaseError
      }
      throw error
    }
    try { await release() }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '')) throw error
      // Windows 可能在杀毒扫描或句柄释放窗口内拒绝删除锁目录；保留它让 stale 机制接管，不能覆盖已完成的状态提交。
    }
    return result
  }

  private async cleanupTemporaryStates(directory: string): Promise<void> {
    const entries = await fs.readdir(directory)
    const temporaryStates = entries.filter((entry) => /^flow-state\.yaml\..+\.tmp$/.test(entry))
    for (const entry of temporaryStates) {
      const temporaryPath = join(directory, entry)
      try {
        await retryWindowsOperation(() => fs.unlink(temporaryPath), `remove ${temporaryPath}`)
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOENT' && !(process.platform === 'win32' && windowsRetryCodes.has(code ?? ''))) throw error
      }
    }
  }

  private async cleanupLegacyLock(directory: string): Promise<void> {
    const legacyPath = join(directory, 'mutation.lock.lock')
    let modifiedAt: number
    try { modifiedAt = (await fs.stat(legacyPath)).mtimeMs }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
      throw error
    }
    if (Date.now() - modifiedAt < Math.max(2_000, this.lockTimeoutMs * 3)) return
    try {
      await retryWindowsOperation(() => fs.rm(legacyPath, { recursive: true, force: true }), `remove ${legacyPath}`)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (!(process.platform === 'win32' && windowsRetryCodes.has(code ?? ''))) throw error
    }
  }

  private async syncParentDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') return
    const dir = await fs.open(dirname(path), 'r')
    try { await dir.sync() } finally { await dir.close() }
  }

  async read(changeId: string): Promise<ChangeState> {
    const source = await fs.readFile(this.statePath(changeId), 'utf8')
    return validateChangeState(parse(source))
  }

  async create(state: ChangeState): Promise<void> {
    validateChangeState(state)
    await this.withLock(state.change_id, async () => {
      const path = this.statePath(state.change_id)
      const handle = await fs.open(path, 'wx')
      try {
        await handle.writeFile(stringify(state, { aliasDuplicateObjects: false }), 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await this.syncParentDirectory(path)
    })
  }

  async mutate<ActionName extends string, Payload>(changeId: string, request: MutationRequest<ActionName, Payload>): Promise<MutationReceipt> {
    return this.withLock(changeId, async () => {
      const path = this.statePath(changeId)
      const state = await this.read(changeId)
      const payloadDigest = digestJson(request.payload)
      const existing = state.history.find((entry) => entry.action_id === request.actionId)
      if (existing) {
        if (existing.payload_digest !== payloadDigest) throw new ContractError('ACTION_CONFLICT', ['actionId already committed with different payload'])
        return { actionId: request.actionId, payloadDigest, previousVersion: existing.from_version, stateVersion: existing.to_version, replayed: true }
      }
      if (request.expectedVersion !== state.state_version) throw new ContractError('VERSION_CONFLICT', [`expected ${request.expectedVersion}, current ${state.state_version}`])
      if (request.expectedStateDigest !== undefined && request.expectedStateDigest !== digestJson(state)) throw new ContractError('VERSION_CONFLICT', ['state content changed without a version increment'])
      const event: ReducerEvent = { type: request.action, actionId: request.actionId, at: new Date().toISOString(), payload: request.payload as Record<string, any> }
      const next = reduce(state, event)
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      const handle = await fs.open(temp, 'wx')
      try {
        await handle.writeFile(stringify(next, { aliasDuplicateObjects: false }), 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await retryWindowsOperation(() => this.replaceFile(temp, path), `replace ${path}`)
      try {
        await retryWindowsOperation(() => fs.unlink(temp), `remove ${temp}`)
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOENT' && !(process.platform === 'win32' && windowsRetryCodes.has(code ?? ''))) throw error
      }
      await this.syncParentDirectory(path)
      return { actionId: request.actionId, payloadDigest, previousVersion: state.state_version, stateVersion: next.state_version, replayed: false }
    })
  }
}
