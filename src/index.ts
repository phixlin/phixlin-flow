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
export type * from './contracts/types.js'
