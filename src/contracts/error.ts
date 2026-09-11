export type ContractErrorCode =
  | 'INVALID_STATE'
  | 'INVALID_WORKFLOW_PROFILE'
  | 'INVALID_EXECUTION_RESULT'
  | 'INVALID_EVENT'
  | 'INVALID_REDUCER_VECTORS'
  | 'PLANNED_SKILL_MISSING'
  | 'RESOURCE_DRIFT'
  | 'LOCK_BUSY'
  | 'VERSION_CONFLICT'
  | 'ACTION_CONFLICT'
  | 'INVALID_ACTION'
  | 'STALE_RESULT'
  | 'EXECUTION_UNKNOWN'
  | 'CODEX_PREFLIGHT_FAILED'

export class ContractError extends Error {
  constructor(
    readonly code: ContractErrorCode,
    readonly issues: string[],
  ) {
    super(`${code}: ${issues.join('; ')}`)
    this.name = 'ContractError'
  }
}
