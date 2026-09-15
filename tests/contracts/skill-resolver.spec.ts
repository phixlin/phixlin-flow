import { describe, expect, it } from 'vitest'
import { ContractError, FileSkillResolver } from '../../src/index.js'

describe('FileSkillResolver', () => {
  it('resolves a local Skill and recursively snapshots resources', async () => {
    const resolver = new FileSkillResolver({ roots: ['fixtures/codex-skills'] })
    const skill = await resolver.resolve('local-resource-reader')
    expect(skill.name).toBe('local-resource-reader')
    expect(skill.path).toBe('local-resource-reader/SKILL.md')
    expect(skill.resources.map((resource) => resource.path)).toEqual(['references/token.txt'])
  })

  it('fails before snapshotting when a declared local resource is absent', async () => {
    const resolver = new FileSkillResolver({ roots: ['fixtures/codex-skills'] })
    await expect(resolver.resolve('missing-resource')).rejects.toEqual(
      expect.objectContaining<Partial<ContractError>>({ code: 'PLANNED_SKILL_MISSING' }),
    )
  })

  it('rejects a Skill reference outside the configured roots', async () => {
    const resolver = new FileSkillResolver({ roots: ['fixtures/codex-skills'] })
    await expect(resolver.resolve('../package.json')).rejects.toEqual(
      expect.objectContaining<Partial<ContractError>>({ code: 'PLANNED_SKILL_MISSING' }),
    )
  })
})
