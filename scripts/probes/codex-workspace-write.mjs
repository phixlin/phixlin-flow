#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = await mkdtemp(join(tmpdir(), 'phixlin-codex-preflight-'))
const output = join(root, 'events.jsonl')
const mode = process.env.CODEX_SANDBOX_MODE ?? 'workspace-write'
if (!['workspace-write', 'danger-full-access'].includes(mode)) throw new Error(`unsupported sandbox mode: ${mode}`)
const markerValue = mode === 'danger-full-access' ? 'PHIXLIN_DANGER_FULL_ACCESS_OK' : 'PHIXLIN_WORKSPACE_WRITE_OK'
const prompt = `Create a file named codex-preflight.txt containing exactly ${markerValue}, then exit.`
const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', mode, '--json', '-C', root, prompt]
const child = spawn(process.env.CODEX_BIN ?? 'codex', args, { stdio: ['ignore', 'pipe', 'pipe'] })
const timeout = setTimeout(() => child.kill('SIGTERM'), Number(process.env.CODEX_PREFLIGHT_TIMEOUT_MS ?? 45000))
const stdout = []
const stderr = []
child.stdout.on('data', (chunk) => stdout.push(chunk))
child.stderr.on('data', (chunk) => stderr.push(chunk))
const exitCode = await new Promise((resolve) => child.on('close', resolve))
clearTimeout(timeout)
await writeFile(output, Buffer.concat(stdout))
let marker = null
try { marker = (await readFile(join(root, 'codex-preflight.txt'), 'utf8')).trim() } catch { /* Missing marker is the failed capability evidence. */ }
const errorText = Buffer.concat(stderr).toString('utf8')
const eventText = Buffer.concat(stdout).toString('utf8')
const combinedText = `${errorText}\n${eventText}`
const report = {
  schema: 'phixlin.codex-workspace-write-probe.v1',
  sandbox_mode: mode,
  exit_code: exitCode,
  marker,
  events_sha256: createHash('sha256').update(eventText).digest('hex'),
  error: combinedText.includes('RTM_NEWADDR') ? 'SANDBOX_NETWORK_NAMESPACE_UNAVAILABLE' : (exitCode === null ? 'PREFLIGHT_TIMEOUT' : (marker === null ? 'WORKSPACE_WRITE_MARKER_MISSING' : null)),
  passed: exitCode === 0 && marker === markerValue,
}
process.stdout.write(`${JSON.stringify(report)}\n`)
await rm(root, { recursive: true, force: true })
process.exitCode = report.passed ? 0 : 1
