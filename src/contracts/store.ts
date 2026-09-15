import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { flock } from 'fs-ext'
import { parse, stringify } from 'yaml'
import { digestJson } from './digest.js'
import { ContractError } from './error.js'
import { reduce, type ReducerEvent } from './reducer.js'
import { validateChangeState } from './validation.js'
import type { ChangeState, MutationReceipt, MutationRequest, StateMutationStore } from './types.js'

/** File-backed CAS store. The lock inode is never removed, so process exit releases it safely. */
export class FileStateMutationStore implements StateMutationStore {
  constructor(
    private readonly root: string,
    private readonly lockTimeoutMs = 10_000,
  ) {}

  private statePath(changeId: string): string { return join(this.root, changeId, 'flow-state.yaml') }
  private lockPath(changeId: string): string { return join(this.root, changeId, 'mutation.lock') }

  private async withLock<T>(changeId: string, fn: () => Promise<T>): Promise<T> {
    const path = this.lockPath(changeId)
    await fs.mkdir(dirname(path), { recursive: true })
    const fd = await fs.open(path, 'a+')
    try {
      await new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const attempt = () => {
          flock(fd.fd, 'exnb', (error) => {
            if (!error) return resolve()
            if (Date.now() - start >= this.lockTimeoutMs) return reject(new ContractError('LOCK_BUSY', ['mutation lock timeout']))
            setTimeout(attempt, 10)
          })
        }
        attempt()
      })
      return await fn()
    } finally {
      try { await new Promise<void>((resolve) => flock(fd.fd, 'un', () => resolve())) } finally { await fd.close() }
    }
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
      const dir = await fs.open(dirname(path), 'r')
      try { await dir.sync() } finally { await dir.close() }
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
      await fs.rename(temp, path)
      const dir = await fs.open(dirname(path), 'r')
      try { await dir.sync() } finally { await dir.close() }
      return { actionId: request.actionId, payloadDigest, previousVersion: state.state_version, stateVersion: next.state_version, replayed: false }
    })
  }
}
