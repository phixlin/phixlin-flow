#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { randomUUID } from 'node:crypto'
import { createWorkflowSnapshot } from './contracts/workflow.js'
import { digestJson } from './contracts/digest.js'
import { FileStateMutationStore } from './contracts/store.js'
import { validateWorkflowProfile } from './contracts/validation.js'
import { CodexRuntimeAdapter } from './runtime/codex.js'
import { FileEvidenceStore } from './runtime/evidence.js'
import { FileSkillResolver } from './runtime/skill-resolver.js'
import { StageRunner } from './runtime/stage-runner.js'
import type { ChangeState } from './contracts/types.js'
import { exportEvidenceBundle, verifyEvidenceBundle } from './operations/evidence.js'
import { buildStatus, getNextAction } from './operations/status.js'

function option(args: string[], name: string, required = false): string | undefined {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  if (required && (!value || value.startsWith('--'))) throw new Error(`缺少 ${name}`)
  return value
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} 格式非法`)
  return value
}

function context() {
  const repository = process.cwd()
  const changes = join(repository, '.phixlin', 'changes')
  return { repository, changes, store: new FileStateMutationStore(changes) }
}

function nextAction(state: ChangeState): string {
  return getNextAction(state)
}

async function verifyArtifacts(state: ChangeState, evidence: FileEvidenceStore): Promise<void> {
  const references: { path: string; sha256: string; bytes: number }[] = []
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) collect(item); return }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.path === 'string' && record.path.startsWith('artifacts/') && typeof record.sha256 === 'string' && typeof record.bytes === 'number') references.push(record as { path: string; sha256: string; bytes: number })
    for (const child of Object.values(record)) collect(child)
  }
  collect(state)
  for (const reference of new Map(references.map((item) => [item.path, item])).values()) await evidence.read(reference)
}

async function sensitiveValues(args: string[]): Promise<string[] | undefined> {
  const path = option(args, '--sensitive-values-file')
  if (!path) return undefined
  const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) throw new Error('--sensitive-values-file 必须是非空字符串数组')
  return value as string[]
}

async function mutateHuman(command: string, changeId: string, args: string[], payload: Record<string, unknown>) {
  const { store } = context()
  const state = await store.read(changeId)
  const expectedVersion = Number(option(args, '--expected-version', true))
  const expectedAction = option(args, '--expected-action', true)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('--expected-version 必须是非负整数')
  if (expectedAction !== nextAction(state)) throw new Error(`预期动作不匹配：当前是 ${nextAction(state)}`)
  await store.mutate(changeId, { expectedVersion, actionId: randomUUID(), action: command, payload })
  return store.read(changeId)
}

async function commentArtifact(changeId: string, args: string[], fallback: string) {
  const path = option(args, '--body-file')
  const content = path ? await readFile(resolve(path), 'utf8') : fallback
  return new FileEvidenceStore(join(context().changes, changeId)).write(content)
}

async function start(changeId: string, args: string[]) {
  const { repository, changes, store } = context()
  identifier(changeId, 'change-id')
  const workflowName = identifier(option(args, '--workflow', true)!, 'workflow')
  const briefPath = resolve(option(args, '--brief', true)!)
  const profile = validateWorkflowProfile(parse(await readFile(join(repository, '.phixlin', 'workflows', `${workflowName}.yaml`), 'utf8')))
  const skills = new FileSkillResolver({ roots: [join(repository, '.agents', 'skills'), join(repository, '.codex', 'skills')], repositoryRoot: repository })
  const workflow = await createWorkflowSnapshot(profile, (reference) => skills.resolve(reference))
  const changeRoot = join(changes, changeId)
  const evidence = new FileEvidenceStore(changeRoot)
  const briefContent = await readFile(briefPath, 'utf8')
  const brief = await evidence.write(briefContent)
  const baseline = await evidence.write(JSON.stringify({ repository, created_from: 'git HEAD' }))
  const now = new Date().toISOString()
  const first = workflow.stages.shape[0]
  const state: ChangeState = {
    schema: 'phixlin.flow.v1', change_id: changeId, title: basename(briefPath), state_version: 0, created_at: now, updated_at: now,
    workspace: { root: repository, repository: basename(repository), baseline, allowed_paths: ['.'] }, workflow,
    outer: { phase: 'shape', status: 'active', stage_visit: 1, iteration: 0 },
    inner: { state: 'ready', position: { action: first ? 'skill' : 'agent-work', skill_index: first ? 0 : null, turn: 0, attempt: 0 } },
    budget: { turns_used: 0, turn_limit: 20, execution_failures: 0, execution_failure_limit: 3, repairs_used: 0, repair_limit: 3, no_progress: 0, no_progress_limit: 3 },
    skills: workflow.stages.shape.map((skill, index) => ({ invocation_id: `shape-visit-1-skill-${index}`, mode: 'planned', index, name: skill.name, source_digest: skill.digest, observation: 'host-observed', status: 'pending', attempts: 0, input_digest: null, raw_output: null, artifacts: [], workspace_before: null, workspace_after: null, completed_by: null })),
    stage_context: { binding: { change_id: changeId, stage_visit: 1, workflow_digest: workflow.digest, brief_revision: 1, spec_revision: null, candidate_id: null, input_digest: digestJson(briefContent) }, revision: 1, planned_completed: [], execution_records: [], stage_artifacts: [] },
    brief: { revision: 1, digest: brief.sha256, artifact: brief, confirmed: null }, shape: null, candidate: null, verification: null, interaction: null, blocker: null, finalization: { state: 'pending' }, history: [],
  }
  await store.create(state)
  return state
}

async function exportEvidence(changeId: string, args: string[]) {
  const { changes, store } = context()
  const state = await store.read(changeId)
  return exportEvidenceBundle(state, join(changes, changeId), option(args, '--output', true)!)
}

async function main() {
  const [command, changeId, ...args] = process.argv.slice(2)
  if (!command || !changeId) throw new Error('用法：phixlin-flow <command> <change-id> [options]')
  if (command === 'verify-evidence') {
    process.stdout.write(`${JSON.stringify(await verifyEvidenceBundle(changeId), null, 2)}\n`)
    return
  }
  identifier(changeId, 'change-id')
  const { repository, changes, store } = context()
  let output: unknown
  if (command === 'start') output = await start(changeId, args)
  else if (command === 'status') output = buildStatus(await store.read(changeId))
  else if (command === 'history') output = (await store.read(changeId)).history
  else if (command === 'export-evidence') output = await exportEvidence(changeId, args)
  else if (command === 'pause') output = await mutateHuman(command, changeId, args, {})
  else if (command === 'resume') {
    let state = await store.read(changeId)
    const expectedVersion = Number(option(args, '--expected-version', true))
    const expectedAction = option(args, '--expected-action', true)
    if (expectedVersion !== state.state_version || expectedAction !== nextAction(state)) throw new Error(`状态已变化：版本 ${state.state_version}，下一动作 ${nextAction(state)}`)
    const root = join(changes, changeId)
    const evidence = new FileEvidenceStore(root)
    await verifyArtifacts(state, evidence)
    if (state.outer.status === 'paused') {
      await store.mutate(changeId, { expectedVersion: state.state_version, expectedStateDigest: digestJson(state), actionId: randomUUID(), action: 'resume-state', payload: {} })
      state = await store.read(changeId)
    }
    const skills = new FileSkillResolver({ roots: [join(repository, '.agents', 'skills'), join(repository, '.codex', 'skills')], repositoryRoot: repository })
    const runtime = new CodexRuntimeAdapter({ evidence, cwd: repository, sandbox: option(args, '--sandbox') as 'workspace-write' | 'danger-full-access' | 'read-only' | undefined, sensitiveValues: await sensitiveValues(args) })
    const maxStepsValue = option(args, '--max-steps')
    const maxSteps = maxStepsValue === undefined ? 100 : Number(maxStepsValue)
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('--max-steps 必须是正整数')
    output = (await new StageRunner(store, runtime, { evidence, skills }).drive(changeId, maxSteps)).state
  } else if (command === 'answer') {
    const body = await readFile(resolve(option(args, '--body-file', true)!), 'utf8')
    const answerArtifact = await new FileEvidenceStore(join(changes, changeId)).write(body)
    output = await mutateHuman('user-answer', changeId, args, { interaction_id: option(args, '--interaction', true), answer_artifact: answerArtifact })
  } else if (command === 'confirm-shape') {
    const state = await store.read(changeId); output = await mutateHuman(command, changeId, args, { subject_digest: state.shape?.digest, actor: option(args, '--actor', true), comment_artifact: await commentArtifact(changeId, args, '确认 Shape') })
  } else if (command === 'accept-result') {
    const state = await store.read(changeId); output = await mutateHuman(command, changeId, args, { candidate_id: state.candidate?.candidate_id, candidate_digest: state.candidate?.candidate_digest, actor: option(args, '--actor', true), comment_artifact: await commentArtifact(changeId, args, '接受结果') })
  } else if (command === 'request-changes') {
    const state = await store.read(changeId); const comment = await readFile(resolve(option(args, '--body-file', true)!), 'utf8')
    const commentArtifact = await new FileEvidenceStore(join(changes, changeId)).write(comment)
    output = await mutateHuman(command, changeId, args, { candidate_id: state.candidate?.candidate_id, candidate_digest: state.candidate?.candidate_digest, comment_artifact: commentArtifact, requirements_changed: args.includes('--requirements-changed') })
  } else if (command === 'retry') {
    output = await mutateHuman('retry-blocker', changeId, args, {})
  } else throw new Error(`未知命令：${command}`)
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
