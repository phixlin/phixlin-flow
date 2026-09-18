import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContractError, FileSkillResolver, digestJson, sha256, type SkillSnapshot } from '../../src/index.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(content: string, resources: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'phixlin-skill-'))
  roots.push(root)
  const directory = join(root, 'sample')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), content)
  for (const [path, value] of Object.entries(resources)) {
    await mkdir(join(directory, path, '..'), { recursive: true })
    await writeFile(join(directory, path), value)
  }
  return { root, directory, resolver: new FileSkillResolver({ roots: [root], repositoryRoot: root }) }
}

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

  it('要求至少一个 Skill root 并拒绝绝对路径和反斜杠', async () => {
    expect(() => new FileSkillResolver({ roots: [] })).toThrow('at least one Skill root')
    const resolver = new FileSkillResolver({ roots: ['fixtures/codex-skills'] })
    await expect(resolver.resolve('/tmp/SKILL.md')).rejects.toMatchObject({ code: 'PLANNED_SKILL_MISSING' })
    await expect(resolver.resolve('bad\\SKILL.md')).rejects.toMatchObject({ code: 'PLANNED_SKILL_MISSING' })
  })

  it('支持 repositoryRoot 下的直接 SKILL.md 路径和 front matter 名称', async () => {
    const { resolver } = await fixture('---\nname: displayed-name\n---\nRead `references/info.txt`.\n', { 'references/info.txt': 'info' })
    const skill = await resolver.resolve('sample/SKILL.md')
    expect(skill).toMatchObject({ name: 'displayed-name', path: 'sample/SKILL.md' })
    expect(skill.resources.map(({ path }) => path)).toEqual(['references/info.txt'])
  })

  it.each([
    ['损坏 front matter', '---\nname: [\n---\n'],
    ['缺少 front matter 名称', '---\ndescription: test\n---\n'],
    ['空 front matter 名称', '---\nname: ""\n---\n'],
  ])('拒绝%s', async (_name, content) => {
    const { resolver } = await fixture(content)
    await expect(resolver.resolve('sample')).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_PROFILE' })
  })

  it.skipIf(process.platform === 'win32')('拒绝资源符号链接和逃逸 root 的 Skill 符号链接', async () => {
    const resourceFixture = await fixture('# skill\n')
    await writeFile(join(resourceFixture.root, 'target.txt'), 'target')
    await symlink(join(resourceFixture.root, 'target.txt'), join(resourceFixture.directory, 'linked.txt'))
    await expect(resourceFixture.resolver.resolve('sample')).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_PROFILE' })

    const root = await mkdtemp(join(tmpdir(), 'phixlin-skill-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'phixlin-skill-outside-'))
    roots.push(root, outside)
    await writeFile(join(outside, 'SKILL.md'), '# outside\n')
    await symlink(outside, join(root, 'linked'))
    await expect(new FileSkillResolver({ roots: [root] }).resolve('linked')).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_PROFILE' })
  })

  it('加载冻结快照并检测内容、资源和缺失漂移', async () => {
    const { resolver } = await fixture('# skill\n', { 'references/a.txt': 'a' })
    const resolved = await resolver.resolve('sample')
    const resources = resolved.resources.map((resource) => ({ path: resource.path, sha256: sha256(resource.content), bytes: resource.content.byteLength }))
    const snapshot: SkillSnapshot = { name: resolved.name, path: resolved.path, digest: sha256(resolved.content), resources, source_commit: null }
    await expect(resolver.load(snapshot)).resolves.toBe('# skill\n')

    await writeFile(join(roots[0]!, 'sample', 'SKILL.md'), '# changed\n')
    await expect(resolver.load(snapshot)).rejects.toMatchObject({ code: 'RESOURCE_DRIFT' })
    snapshot.path = 'missing/SKILL.md'
    await expect(resolver.load(snapshot)).rejects.toMatchObject({ code: 'PLANNED_SKILL_MISSING' })
    expect(digestJson(resources)).toHaveLength(64)
  })

  it('拒绝冻结快照路径逃逸 root', async () => {
    const { resolver } = await fixture('# skill\n')
    const snapshot: SkillSnapshot = { name: 'bad', path: '../SKILL.md', digest: '0'.repeat(64), resources: [], source_commit: null }
    await expect(resolver.load(snapshot)).rejects.toMatchObject({ code: 'RESOURCE_DRIFT' })
  })

  it('拒绝不存在的 Skill、逃逸声明和目录形式资源', async () => {
    const { resolver } = await fixture('Read `references/../../outside.txt`.\n')
    await expect(resolver.resolve('absent')).rejects.toMatchObject({ code: 'PLANNED_SKILL_MISSING' })
    await expect(resolver.resolve('sample')).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_PROFILE' })

    const directoryResource = await fixture('Read `references/data`.\n')
    await mkdir(join(directoryResource.directory, 'references', 'data'), { recursive: true })
    await expect(directoryResource.resolver.resolve('sample')).rejects.toMatchObject({ code: 'PLANNED_SKILL_MISSING' })
  })

  it('检测仅资源内容发生的漂移', async () => {
    const { root, resolver } = await fixture('# skill\n', { 'references/a.txt': 'a' })
    const resolved = await resolver.resolve('sample')
    const snapshot: SkillSnapshot = {
      name: resolved.name,
      path: resolved.path,
      digest: sha256(resolved.content),
      resources: resolved.resources.map((resource) => ({ path: resource.path, sha256: sha256(resource.content), bytes: resource.content.byteLength })),
      source_commit: null,
    }
    await writeFile(join(root, 'sample', 'references', 'a.txt'), 'changed')
    await expect(resolver.load(snapshot)).rejects.toMatchObject({ code: 'RESOURCE_DRIFT' })
  })
})
