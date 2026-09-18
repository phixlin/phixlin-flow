import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../contracts/digest.js'
import codexStageSchema from '../../schemas/codex-stage-result-v1.schema.json' with { type: 'json' }
import type { FileEvidenceStore } from './evidence.js'
import type { RuntimeAdapter, RuntimeInput, RuntimeResult } from './fake.js'

export interface CodexRuntimeOptions {
  evidence: FileEvidenceStore
  cwd: string
  sandbox?: 'workspace-write' | 'danger-full-access' | 'read-only'
  command?: string
  timeoutMs?: number
  sensitiveValues?: string[]
  spawn?: typeof nodeSpawn
}

/** Executes one isolated non-interactive Codex turn and persists its raw event stream. */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  private readonly spawn
  constructor(private readonly options: CodexRuntimeOptions) {
    if (options.sensitiveValues?.some((value) => value.length === 0)) throw new Error('sensitiveValues 不能包含空字符串')
    this.spawn = options.spawn ?? nodeSpawn
  }

  private redact(value: string): string {
    return (this.options.sensitiveValues ?? []).reduce((text, sensitive) => text.split(sensitive).join('[REDACTED]'), value)
  }

  async execute(input: RuntimeInput): Promise<RuntimeResult> {
    if (input.action === 'run-checks') return this.runChecks(input)
    const context = input.skillInput ?? JSON.stringify({ action: input.action, phase: input.state.outer.phase })
    const instructions: Record<string, string> = {
      skill: 'Follow the supplied Skill instructions. Return kind stage-ready when the Skill work is complete.',
      'agent-work:shape': 'Analyze the request without modifying the workspace. Return kind stage-ready and shape with document, acceptance, and checks. Each check argv must be directly executable without a shell.',
      'agent-work:build': 'Implement the confirmed specification in the workspace. Return kind stage-ready after the changes are complete.',
      'review-candidate': 'Review the current candidate independently. Return kind stage-ready and review with verdict pass or fail and a concrete report.',
      'verify-candidate': 'Verify every frozen acceptance item against the current candidate and host check results. Return kind stage-ready and verification with verdict and one result for every acceptance ID.',
    }
    const key = input.action === 'agent-work' ? `${input.action}:${input.state.outer.phase}` : input.action
    const prompt = `${context}\n\n${instructions[key] ?? 'Complete the current stage action.'} Return one JSON object conforming to ${codexStageSchema.title}. Do not invent artifact paths, hashes, execution IDs, candidate IDs, or command exit codes.`
    const schema = fileURLToPath(new URL('../../schemas/codex-stage-result-v1.schema.json', import.meta.url))
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', this.options.sandbox ?? 'workspace-write', '--json', '--output-schema', schema, '-C', this.options.cwd, prompt]
    const child = this.spawn(this.options.command ?? 'codex', args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, this.options.timeoutMs ?? 120_000)
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))
    clearTimeout(timeout)
    const eventText = this.redact(Buffer.concat(stdout).toString('utf8'))
    const stderrText = this.redact(Buffer.concat(stderr).toString('utf8').trim())
    const eventRef = await this.options.evidence.write(eventText)
    if (timedOut || exitCode !== 0) return { kind: 'blocked', summary: timedOut ? 'Codex execution timed out' : `Codex exited with code ${exitCode}`, artifacts: [eventRef], questions: [], proposal: null }
    let semantic: Record<string, any> | undefined
    for (const line of eventText.split(/\r?\n/).filter(Boolean)) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (typeof value.kind === 'string') semantic = value
        else if (value.result && typeof value.result === 'object' && typeof (value.result as Record<string, unknown>).kind === 'string') semantic = value.result as Record<string, any>
        else if (value.item && typeof value.item === 'object' && typeof (value.item as Record<string, unknown>).text === 'string') {
          try { const parsed = JSON.parse((value.item as Record<string, unknown>).text as string) as Record<string, any>; if (typeof parsed.kind === 'string') semantic = parsed } catch { /* Agent text may be non-JSON commentary. */ }
        }
      } catch { /* Ignore non-JSON diagnostics; the final parse below is authoritative. */ }
    }
    if (!semantic) return { kind: 'blocked', summary: `Codex returned no structured result${stderrText ? `: ${stderrText}` : ''}`, artifacts: [eventRef], questions: [], proposal: null }
    return this.bindResult(input, semantic, eventRef)
  }

  private async bindResult(input: RuntimeInput, value: Record<string, any>, eventRef: Awaited<ReturnType<FileEvidenceStore['write']>>): Promise<RuntimeResult> {
    const result: RuntimeResult = { kind: value.kind, summary: String(value.summary ?? ''), questions: Array.isArray(value.questions) ? value.questions : [], proposal: value.proposal ?? null, artifacts: [eventRef] }
    if (input.action === 'skill') return result
    if (input.action === 'agent-work' && input.state.outer.phase === 'shape' && value.shape) {
      const document = await this.options.evidence.write(String(value.shape.document ?? value.summary ?? ''))
      result.shape = { documents: [document], acceptance: value.shape.acceptance ?? [], checks: value.shape.checks ?? [] }
    }
    if (input.action === 'agent-work' && input.state.outer.phase === 'build') result.candidate = await this.captureCandidate(value.summary)
    if (input.action === 'review-candidate' && input.state.candidate) {
      const report = await this.options.evidence.write(String(value.review?.report ?? value.summary ?? ''))
      result.review = { candidate_id: input.state.candidate.candidate_id, candidate_digest: input.state.candidate.candidate_digest, verdict: value.review?.verdict, report }
    }
    if (input.action === 'verify-candidate' && input.state.candidate) {
      result.verification = { candidate_id: input.state.candidate.candidate_id, candidate_digest: input.state.candidate.candidate_digest, verdict: value.verification?.verdict, acceptance: value.verification?.acceptance ?? [] }
    }
    return result
  }

  private async workspaceManifest(): Promise<{ text: string; files: { path: string; sha256: string; bytes: number }[] }> {
    const status = await this.command(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (status.code !== 0) throw new Error(`git status failed: ${status.stderr}`)
    const entries = status.stdout.split('\0').filter(Boolean).filter((line) => !line.slice(3).startsWith('.phixlin/')).sort()
    const paths = entries.map((line) => line.slice(3)).sort()
    const files = []
    for (const path of paths) {
      const absolute = resolve(this.options.cwd, path)
      if (!relative(this.options.cwd, absolute).startsWith('..')) {
        try { const bytes = await readFile(absolute); files.push({ path, sha256: sha256(bytes), bytes: bytes.length }) } catch { /* Deleted files are represented by Git status. */ }
      }
    }
    return { text: entries.join('\0'), files }
  }

  async inspectCandidate(): Promise<string> {
    const manifest = await this.workspaceManifest()
    return sha256(Buffer.from(JSON.stringify({ status: manifest.text, files: manifest.files })))
  }

  private async captureCandidate(summary: unknown): Promise<NonNullable<RuntimeResult['candidate']>> {
    const manifest = await this.workspaceManifest()
    const diffResult = await this.command(['git', 'diff', '--binary', '--no-ext-diff', 'HEAD'])
    if (diffResult.code !== 0) throw new Error(`git diff failed: ${diffResult.stderr}`)
    const fileManifest = await this.options.evidence.write(JSON.stringify({ status: manifest.text, files: manifest.files }))
    const diff = await this.options.evidence.write(JSON.stringify({ git_diff: diffResult.stdout, files: manifest.files }))
    return { candidate_digest: fileManifest.sha256, file_manifest: fileManifest, diff, summary: String(summary ?? ''), addressed_acceptance_ids: [], known_limits: [] }
  }

  private async runChecks(input: RuntimeInput): Promise<RuntimeResult> {
    const checks = []
    for (const check of input.state.shape?.checks ?? []) {
      const cwd = resolve(this.options.cwd, check.cwd)
      const relativeCwd = relative(this.options.cwd, cwd)
      if (relativeCwd === '..' || relativeCwd.startsWith('../') || relativeCwd.startsWith('..\\')) throw new Error(`检查 cwd 超出工作区：${check.cwd}`)
      const execution = await this.command(check.argv, cwd, check.timeout_ms)
      const report = await this.options.evidence.write(JSON.stringify({ argv: check.argv, cwd: check.cwd, exit_code: execution.code, stdout: execution.stdout, stderr: execution.stderr }))
      checks.push({ id: check.id, result: execution.code === 0 ? 'pass' as const : 'fail' as const, exit_code: execution.code, report })
    }
    return { kind: 'stage-ready', summary: '宿主检查已完成', artifacts: checks.flatMap((check) => check.report ? [check.report] : []), questions: [], proposal: null, checks }
  }

  private command(argv: string[], cwd = this.options.cwd, timeoutMs = this.options.timeoutMs ?? 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveResult, reject) => {
      const child = nodeSpawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []; const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk)); child.on('error', reject)
      const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.on('close', (code) => { clearTimeout(timeout); resolveResult({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }) })
    })
  }
}
