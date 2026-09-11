export const packageName = '@phixlin/phixlin-flow'

export { decide } from './contracts/decide.js'
export { canonicalJson, digestJson, sha256 } from './contracts/digest.js'
export { ContractError } from './contracts/error.js'
export {
  parseChangeStateYaml,
  parseWorkflowProfileYaml,
  validateChangeState,
  validateDiagnosticEvent,
  validateExecutionResult,
  validateReducerVectors,
  validateWorkflowProfile,
} from './contracts/validation.js'
export { createWorkflowSnapshot } from './contracts/workflow.js'
export { reduce } from './contracts/reducer.js'
export { FileStateMutationStore } from './contracts/store.js'
export { FakeRuntime } from './runtime/fake.js'
export { StageRunner } from './runtime/stage-runner.js'
export { runCodexPreflight, runCodexWorkspaceWritePreflight } from './runtime/codex-preflight.js'
export type { CodexPreflightResult, CodexSandboxMode } from './runtime/codex-preflight.js'
export type { RuntimeAdapter, RuntimeInput, RuntimeResult, DriveResult, StageRunnerOptions, MutationPort } from './runtime/index.js'
export type * from './contracts/types.js'
