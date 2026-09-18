import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalJson,
  ContractError,
  createWorkflowSnapshot,
  parseWorkflowProfileYaml,
  sha256,
  type ResolvedSkill,
} from '../../src/index.js'

const profileSource = readFileSync('fixtures/workflow/standard.yaml', 'utf8')

function resolved(reference: string): ResolvedSkill {
  return {
    name: reference,
    path: `.agents/skills/${reference}/SKILL.md`,
    content: Buffer.from(`# ${reference}\n`),
    resources: [
      { path: 'references/z-last.md', content: Buffer.from('z') },
      { path: 'references/a-first.md', content: Buffer.from('a') },
    ],
    source_commit: null,
  }
}

describe('Workflow Profile v1 contract', () => {
  it('accepts an empty Build Skill list and creates a frozen snapshot', async () => {
    const profile = parseWorkflowProfileYaml(profileSource)
    const resolver = vi.fn(async (reference: string) => resolved(reference))

    const snapshot = await createWorkflowSnapshot(profile, resolver)

    expect(snapshot.runtime).toBe('codex')
    expect(snapshot.stages.build).toEqual([])
    expect(snapshot.stages.shape[0]?.resources.map((resource) => resource.path)).toEqual([
      'references/a-first.md',
      'references/z-last.md',
    ])
    expect(snapshot.stages.shape[0]?.digest).toBe(sha256('# local-shape\n'))
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['missing workflow', profileSource.replace('workflow: phixlin-flow-v1\n', '')],
    ['missing runtime', profileSource.replace('runtime: codex\n', '')],
    [
      'illegal stage',
      profileSource.replace('  verify:\n', '  completed:\n    skills: []\n  verify:\n'),
    ],
    [
      'duplicate Skill',
      profileSource.replace('      - local-shape\n', '      - local-shape\n      - local-shape\n'),
    ],
  ])('rejects %s', (_name, source) => {
    expect(() => parseWorkflowProfileYaml(source)).toThrowError(
      expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_WORKFLOW_PROFILE' }),
    )
  })

  it('fails loudly when a planned Skill cannot be resolved', async () => {
    const profile = parseWorkflowProfileYaml(profileSource)
    await expect(
      createWorkflowSnapshot(profile, async (reference) => {
        throw new Error(`missing ${reference}`)
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<ContractError>>({ code: 'PLANNED_SKILL_MISSING' }))
  })

  it('reports a non-Error resolver failure', async () => {
    const profile = parseWorkflowProfileYaml(profileSource)
    await expect(
      createWorkflowSnapshot(profile, async () => Promise.reject('not installed')),
    ).rejects.toThrow('not installed')
  })

  it.each(['/absolute/SKILL.md', 'skill\\SKILL.md', 'skill/../SKILL.md'])(
    'rejects resolved path %s',
    async (path) => {
      const profile = parseWorkflowProfileYaml(profileSource)
      await expect(
        createWorkflowSnapshot(profile, async (reference) => ({ ...resolved(reference), path })),
      ).rejects.toEqual(
        expect.objectContaining<Partial<ContractError>>({ code: 'INVALID_WORKFLOW_PROFILE' }),
      )
    },
  )

  it('rejects a duplicate resolved resource', async () => {
    const profile = parseWorkflowProfileYaml(profileSource)
    await expect(
      createWorkflowSnapshot(profile, async (reference) => {
        const skill = resolved(reference)
        skill.resources = [skill.resources[0], structuredClone(skill.resources[0])]
        return skill
      }),
    ).rejects.toThrow('contains duplicate resource')
  })

  it('rejects duplicate names produced by aliases', async () => {
    const source = profileSource.replace(
      '      - local-shape\n',
      '      - local-shape\n      - local-shape-alias\n',
    )
    const profile = parseWorkflowProfileYaml(source)
    await expect(
      createWorkflowSnapshot(profile, async (reference) => ({ ...resolved(reference), name: 'same-name' })),
    ).rejects.toThrow('resolved shape stage contains duplicate Skill names')
  })

  it('canonicalizes nested object keys and rejects undefined', () => {
    expect(canonicalJson({ z: [2, { b: true, a: null }], a: 'first' })).toBe(
      '{"a":"first","z":[2,{"a":null,"b":true}]}',
    )
    expect(() => canonicalJson(undefined)).toThrow('does not support undefined')
  })
})
