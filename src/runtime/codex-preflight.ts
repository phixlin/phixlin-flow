import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ContractError } from '../contracts/error.js'

const execFileAsync = promisify(execFile)

export type CodexSandboxMode = 'workspace-write' | 'danger-full-access'

export interface CodexPreflightResult {
  sandbox_mode: CodexSandboxMode
  passed: boolean
  exit_code: number | null
  marker: string | null
  error: string | null
}

/** Fails closed unless Codex proves workspace-write by creating a marker in a temp workspace. */
export async function runCodexPreflight(mode: CodexSandboxMode = 'workspace-write', codexBin = 'codex'): Promise<CodexPreflightResult> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/probes/codex-workspace-write.mjs'], {
      env: { ...process.env, CODEX_BIN: codexBin, CODEX_SANDBOX_MODE: mode },
      maxBuffer: 1024 * 1024,
      timeout: 50_000,
    })
    const result = JSON.parse(stdout.trim()) as CodexPreflightResult
    if (!result.passed) throw new ContractError('CODEX_PREFLIGHT_FAILED', [result.error ?? 'workspace-write probe failed'])
    return result
  } catch (error) {
    if (error instanceof ContractError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ContractError('CODEX_PREFLIGHT_FAILED', [message])
  }
}

export async function runCodexWorkspaceWritePreflight(codexBin = 'codex'): Promise<CodexPreflightResult> {
  return runCodexPreflight('workspace-write', codexBin)
}
