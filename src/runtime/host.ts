import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { sha256 } from '../contracts/digest.js'
import { validateShapeContent } from '../contracts/validation.js'
import type { RuntimeAdapter, RuntimeInput, RuntimeResult } from './fake.js'
import type { FileEvidenceStore } from './evidence.js'
import hostResultSchema from '../../schemas/host-result-v1.schema.json' with { type: 'json' }
import messages from '../i18n/zh-CN.json' with { type: 'json' }

const ajv = new Ajv2020({ allErrors: true })
const validate = ajv.compile(hostResultSchema)

export interface HarnessEvidenceOptions { evidence: FileEvidenceStore; cwd: string }

function commandStartError(argv: string[], cwd: string, purpose: string, error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error))
  const code = (source as NodeJS.ErrnoException).code ?? 'UNKNOWN'
  return new Error(`${purpose}${messages.commandStartFailed}（${code}）：${JSON.stringify(argv)}；cwd=${cwd}。${messages.commandStartRecovery}`, { cause: source })
}

export interface HostSemanticResult {
  kind: RuntimeResult['kind']
  summary: string
  questions: string[]
  proposal: RuntimeResult['proposal']
  skill_invocations?: { name: string; status: 'completed' | 'failed'; output: string }[]
  shape: { document: string; acceptance: NonNullable<RuntimeResult['shape']>['acceptance']; checks: NonNullable<RuntimeResult['shape']>['checks'] } | null
  review: { verdict: 'pass' | 'fail'; report: string } | null
  verification: { verdict: 'pass' | 'fail'; acceptance: NonNullable<RuntimeResult['verification']>['acceptance'] } | null
}

/** 只校验宿主语义交接，并采集不含业务解释的机械证据。 */
export class HarnessEvidenceBoundary {
  constructor(private readonly options: HarnessEvidenceOptions) {}

  async runChecks(input: RuntimeInput): Promise<RuntimeResult> {
    if (input.action !== 'run-checks') throw new Error(messages.hostStageMustSubmit)
    const checks = []
    for (const check of input.state.shape?.checks ?? []) {
      const executable = check.argv[0]?.split(/[\\/]/).at(-1)?.toLowerCase()
      if (/^(codex|claude)(\.(exe|cmd|bat))?$/.test(executable ?? '')) throw new Error(messages.agentCheckForbidden)
      const cwd = resolve(this.options.cwd, check.cwd)
      const relativeCwd = relative(this.options.cwd, cwd)
      if (relativeCwd === '..' || relativeCwd.startsWith('../') || relativeCwd.startsWith('..\\')) throw new Error(`检查 cwd 超出工作区：${check.cwd}`)
      const execution = await this.command(check.argv, cwd, check.timeout_ms)
      const report = await this.options.evidence.write(JSON.stringify({ argv: check.argv, cwd: check.cwd, exit_code: execution.code, stdout: execution.stdout, stderr: execution.stderr }))
      checks.push({ id: check.id, result: execution.code === 0 ? 'pass' as const : 'fail' as const, exit_code: execution.code, report })
    }
    return { kind: 'stage-ready', summary: messages.hostCheckComplete, artifacts: checks.map((check) => check.report), questions: [], proposal: null, checks }
  }

  async bindResult(input: RuntimeInput, submitted: unknown): Promise<RuntimeResult> {
    if (!validate(submitted)) throw new Error(`${messages.hostResultInvalid}：${ajv.errorsText(validate.errors)}`)
    const value = submitted as unknown as HostSemanticResult
    if (value.kind === 'stage-ready') {
      if (input.action === 'agent-work' && input.state.outer.phase === 'shape' && !value.shape) throw new Error(messages.hostShapeMissing)
      if (input.action === 'agent-work' && input.state.outer.phase === 'shape' && value.shape) validateShapeContent(value.shape)
      if (input.action === 'review-candidate' && !value.review) throw new Error(messages.hostReviewMissing)
      if (input.action === 'verify-candidate' && !value.verification) throw new Error(messages.hostVerificationMissing)
    }
    const event = await this.options.evidence.write(JSON.stringify(value))
    const result: RuntimeResult = { kind: value.kind, summary: value.summary, questions: value.questions, proposal: value.proposal, artifacts: [event] }
    if (value.skill_invocations) {
      result.skill_invocations = []
      for (const invocation of value.skill_invocations) result.skill_invocations.push({ name: invocation.name, status: invocation.status, observation: 'model-reported', artifact: await this.options.evidence.write(invocation.output) })
    }
    if (input.action === 'agent-work' && input.state.outer.phase === 'shape' && value.shape) {
      const document = await this.options.evidence.write(value.shape.document)
      result.shape = { documents: [document], acceptance: value.shape.acceptance, checks: value.shape.checks }
    }
    if (input.action === 'agent-work' && input.state.outer.phase === 'build' && value.kind === 'stage-ready') result.candidate = await this.captureCandidate(value.summary)
    if (input.action === 'review-candidate' && value.review && input.state.candidate) {
      const report = await this.options.evidence.write(value.review.report)
      result.review = { candidate_id: input.state.candidate.candidate_id, candidate_digest: input.state.candidate.candidate_digest, verdict: value.review.verdict, report }
    }
    if (input.action === 'verify-candidate' && value.verification && input.state.candidate) {
      result.verification = { candidate_id: input.state.candidate.candidate_id, candidate_digest: input.state.candidate.candidate_digest, verdict: value.verification.verdict, acceptance: value.verification.acceptance }
    }
    return result
  }

  private async workspaceManifest(): Promise<{ text: string; files: { path: string; sha256: string; bytes: number }[] }> {
    const status = await this.command(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], this.options.cwd, 120_000, '采集工作区状态时')
    if (status.code !== 0) throw new Error(`采集工作区状态失败：git status；cwd=${this.options.cwd}；${status.stderr}`)
    const entries = status.stdout.split('\0').filter(Boolean).filter((line) => !line.slice(3).startsWith('.phixlin/')).sort()
    const files = []
    for (const path of entries.map((line) => line.slice(3)).sort()) {
      const absolute = resolve(this.options.cwd, path)
      if (!relative(this.options.cwd, absolute).startsWith('..')) {
        try { const bytes = await readFile(absolute); files.push({ path, sha256: sha256(bytes), bytes: bytes.length }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
    return { text: entries.join('\0'), files }
  }

  async inspectCandidate(): Promise<string> {
    const manifest = await this.workspaceManifest()
    return sha256(Buffer.from(JSON.stringify({ status: manifest.text, files: manifest.files })))
  }

  private async captureCandidate(summary: string): Promise<NonNullable<RuntimeResult['candidate']>> {
    const manifest = await this.workspaceManifest()
    const diffResult = await this.command(['git', 'diff', '--binary', '--no-ext-diff', 'HEAD'], this.options.cwd, 120_000, '采集候选变更时')
    if (diffResult.code !== 0) throw new Error(`采集候选变更失败：git diff；cwd=${this.options.cwd}；${diffResult.stderr}`)
    const fileManifest = await this.options.evidence.write(JSON.stringify({ status: manifest.text, files: manifest.files }))
    const diff = await this.options.evidence.write(JSON.stringify({ git_diff: diffResult.stdout, files: manifest.files }))
    return { candidate_digest: fileManifest.sha256, file_manifest: fileManifest, diff, summary, addressed_acceptance_ids: [], known_limits: [] }
  }

  private command(argv: string[], cwd = this.options.cwd, timeoutMs = 120_000, purpose = '执行命令时'): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveResult, reject) => {
      let child
      try { child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
      catch (error) { reject(commandStartError(argv, cwd, purpose, error)); return }
      const stdout: Buffer[] = []; const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', (error) => reject(commandStartError(argv, cwd, purpose, error)))
      const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.on('close', (code) => { clearTimeout(timeout); resolveResult({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }) })
    })
  }
}

/** 生产 StageRunner 适配器；只允许 Harness 执行冻结的机器检查。 */
export class HarnessMachineCheckRuntime implements RuntimeAdapter {
  constructor(private readonly boundary: HarnessEvidenceBoundary) {}

  async execute(input: RuntimeInput): Promise<RuntimeResult> {
    return this.boundary.runChecks(input)
  }

  inspectCandidate(): Promise<string> {
    return this.boundary.inspectCandidate()
  }
}
