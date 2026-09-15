import { digestJson, sha256 } from './digest.js'
import { ContractError } from './error.js'
import { validateWorkflowProfile } from './validation.js'
import type {
  Phase,
  ResolvedSkill,
  SkillSnapshot,
  WorkflowProfile,
  WorkflowSnapshot,
} from './types.js'

type WorkflowStage = Exclude<Phase, 'completed'>
type SkillResolver = (reference: string) => Promise<ResolvedSkill>

const stages: WorkflowStage[] = ['shape', 'build', 'verify']

function validateRelativePath(resourcePath: string): void {
  if (
    resourcePath.startsWith('/') ||
    resourcePath.includes('\\') ||
    resourcePath.split('/').includes('..')
  ) {
    throw new ContractError('INVALID_WORKFLOW_PROFILE', [
      `resolved Skill path must be a normalized relative path: ${resourcePath}`,
    ])
  }
}

async function snapshotSkill(reference: string, resolver: SkillResolver): Promise<SkillSnapshot> {
  let resolved: ResolvedSkill
  try {
    resolved = await resolver(reference)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ContractError('PLANNED_SKILL_MISSING', [`${reference}: ${message}`])
  }

  validateRelativePath(resolved.path)
  const seen = new Set<string>()
  const resources = [...resolved.resources]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((resource) => {
      validateRelativePath(resource.path)
      if (seen.has(resource.path)) {
        throw new ContractError('INVALID_WORKFLOW_PROFILE', [
          `Skill ${reference} contains duplicate resource ${resource.path}`,
        ])
      }
      seen.add(resource.path)
      return {
        path: resource.path,
        sha256: sha256(resource.content),
        bytes: resource.content.byteLength,
      }
    })

  return {
    name: resolved.name,
    path: resolved.path,
    digest: sha256(resolved.content),
    resources,
    source_commit: resolved.source_commit,
  }
}

export async function createWorkflowSnapshot(
  input: WorkflowProfile,
  resolveSkill: SkillResolver,
): Promise<WorkflowSnapshot> {
  const profile = validateWorkflowProfile(input)
  const snapshotStages = {} as WorkflowSnapshot['stages']
  for (const stage of stages) {
    snapshotStages[stage] = []
    for (const reference of profile.stages[stage].skills) {
      snapshotStages[stage].push(await snapshotSkill(reference, resolveSkill))
    }
    const names = snapshotStages[stage].map((skill) => skill.name)
    if (new Set(names).size !== names.length) {
      throw new ContractError('INVALID_WORKFLOW_PROFILE', [
        `resolved ${stage} stage contains duplicate Skill names`,
      ])
    }
  }

  return {
    name: profile.name,
    version: profile.version,
    workflow: profile.workflow,
    runtime: profile.runtime,
    digest: digestJson(profile),
    stages: snapshotStages,
  }
}
