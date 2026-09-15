import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { FileEvidenceStore } from './evidence.js'
import type { RuntimeAdapter, RuntimeInput, RuntimeResult } from './fake.js'

export interface CodexRuntimeOptions {
  evidence: FileEvidenceStore
  cwd: string
  sandbox?: 'workspace-write' | 'danger-full-access' | 'read-only'
  command?: string
  timeoutMs?: number
  spawn?: typeof nodeSpawn
}

/** Executes one isolated non-interactive Codex turn and persists its raw event stream. */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  private readonly spawn
  constructor(private readonly options: CodexRuntimeOptions) { this.spawn = options.spawn ?? nodeSpawn }

  async execute(input: RuntimeInput): Promise<RuntimeResult> {
    const prompt = input.skillInput ?? JSON.stringify({ action: input.action, phase: input.state.outer.phase })
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', this.options.sandbox ?? 'workspace-write', '--json', '-C', this.options.cwd, prompt]
    const child = this.spawn(this.options.command ?? 'codex', args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, this.options.timeoutMs ?? 120_000)
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))
    clearTimeout(timeout)
    const eventText = Buffer.concat(stdout).toString('utf8')
    const eventRef = await this.options.evidence.write(eventText)
    if (timedOut || exitCode !== 0) return { kind: 'blocked', summary: timedOut ? 'Codex execution timed out' : `Codex exited with code ${exitCode}`, artifacts: [eventRef], questions: [], proposal: null }
    let result: RuntimeResult | undefined
    for (const line of eventText.split(/\r?\n/).filter(Boolean)) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (typeof value.kind === 'string') result = value as unknown as RuntimeResult
        else if (value.result && typeof value.result === 'object' && typeof (value.result as Record<string, unknown>).kind === 'string') result = value.result as RuntimeResult
        else if (value.item && typeof value.item === 'object' && typeof (value.item as Record<string, unknown>).text === 'string') {
          try { const parsed = JSON.parse((value.item as Record<string, unknown>).text as string) as RuntimeResult; if (typeof parsed.kind === 'string') result = parsed } catch { /* Agent text may be non-JSON commentary. */ }
        }
      } catch { /* Ignore non-JSON diagnostics; the final parse below is authoritative. */ }
    }
    if (!result) return { kind: 'blocked', summary: `Codex returned no structured result${stderr.length ? `: ${Buffer.concat(stderr).toString('utf8').trim()}` : ''}`, artifacts: [eventRef], questions: [], proposal: null }
    return { ...result, artifacts: [...result.artifacts, eventRef] }
  }
}
