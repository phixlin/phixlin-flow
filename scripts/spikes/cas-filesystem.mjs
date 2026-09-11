#!/usr/bin/env node
import { constants } from 'node:fs'
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import fsExt from 'fs-ext'

function flock(fileDescriptor, operation) {
  return new Promise((resolveLock, reject) => {
    fsExt.flock(fileDescriptor, operation, (error) => {
      if (error) reject(error)
      else resolveLock()
    })
  })
}

async function holdLock(lockPath, readyPath) {
  const handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600)
  await flock(handle.fd, 'ex')
  const metadata = await handle.stat()
  await writeFile(readyPath, JSON.stringify({ pid: process.pid, inode: metadata.ino }))
  setInterval(() => {}, 60_000)
}

async function tryLock(lockPath) {
  const handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600)
  try {
    await flock(handle.fd, 'exnb')
    await flock(handle.fd, 'un')
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EAGAIN') {
      return false
    }
    throw error
  } finally {
    await handle.close()
  }
}

function runChild(arguments_) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [process.argv[1], ...arguments_], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveChild({ child, code, signal, stdout, stderr }))
  })
}

function spawnHolder(lockPath, readyPath) {
  return spawn(process.execPath, [process.argv[1], 'hold', lockPath, readyPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
}

async function atomicReplace(statePath, contents) {
  const temporaryPath = `${statePath}.tmp-${process.pid}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporaryPath, statePath)
  const directory = await open(dirname(statePath), constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function runSpike(outputPath) {
  const root = await mkdtemp(join(tmpdir(), 'phixlin-cas-spike-'))
  try {
    const lockPath = join(root, 'mutation.lock')
    const readyPath = join(root, 'holder-ready.json')
    const statePath = join(root, 'flow-state.yaml')
    await writeFile(lockPath, '')
    await writeFile(statePath, 'state_version: 0\n')
    const initialLock = await stat(lockPath)

    const holder = spawnHolder(lockPath, readyPath)
    await waitForFile(readyPath, 5_000)
    const heldLock = await stat(lockPath)
    const contention = await runChild(['try', lockPath])
    holder.kill('SIGKILL')
    await waitForExit(holder)
    const afterCrash = await runChild(['try', lockPath])
    const releasedLock = await stat(lockPath)

    const interruptedTemp = `${statePath}.tmp-interrupted`
    await writeFile(interruptedTemp, 'state_version:')
    const stateBeforeRename = await readFile(statePath, 'utf8')
    await rm(interruptedTemp)
    await atomicReplace(statePath, 'state_version: 1\n')
    const stateAfterCommit = await readFile(statePath, 'utf8')

    const report = {
      schema: 'phixlin.cas-filesystem-spike.v1',
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        fs_ext: '2.1.1',
      },
      lock: {
        fixed_inode:
          initialLock.ino === heldLock.ino && heldLock.ino === releasedLock.ino,
        contention_rejected: contention.code === 2,
        crash_released: afterCrash.code === 0,
      },
      atomic_replace: {
        interrupted_temp_did_not_replace_state: stateBeforeRename === 'state_version: 0\n',
        committed_complete_state: stateAfterCommit === 'state_version: 1\n',
        sequence: ['write-temp', 'fsync-temp', 'rename', 'fsync-directory'],
      },
    }
    const passed = Object.values(report.lock).every(Boolean) &&
      report.atomic_replace.interrupted_temp_did_not_replace_state &&
      report.atomic_replace.committed_complete_state
    const result = { ...report, passed }
    const serialized = `${JSON.stringify(result, null, 2)}\n`
    if (outputPath) await writeFile(resolve(outputPath), serialized)
    process.stdout.write(serialized)
    if (!passed) process.exitCode = 1
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const [mode, argument, outputArgument] = process.argv.slice(2)
if (mode === 'hold') {
  await holdLock(argument, outputArgument)
} else if (mode === 'try') {
  process.exitCode = (await tryLock(argument)) ? 0 : 2
} else if (mode === '--output') {
  await runSpike(argument)
} else if (mode === undefined) {
  await runSpike(null)
} else {
  throw new Error(`unknown mode: ${mode}`)
}
