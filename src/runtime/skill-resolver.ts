import { readFile, readdir, stat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ContractError } from '../contracts/error.js'
import { sha256, digestJson } from '../contracts/digest.js'
import type { ResolvedSkill, SkillSnapshot } from '../contracts/types.js'
import { parseDocument } from 'yaml'

export interface SkillResolverOptions {
  roots: string[]
  repositoryRoot?: string
}

const localReference = /(?:`|\]\()((?:references|scripts|assets)\/[^`)\s]+)(?:`|\))/g

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  if (path === '') return true
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return false
  return sep === '\\' || !path.includes('\\')
}

function normalizedRelative(root: string, candidate: string): string {
  const path = relative(root, candidate)
  if (!isInside(root, candidate)) {
    throw new ContractError('INVALID_WORKFLOW_PROFILE', [`Skill path escapes resolver root: ${candidate}`])
  }
  return path.split(sep).join('/')
}

async function filesUnder(root: string, directory: string): Promise<{ path: string; content: Uint8Array }[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: { path: string; content: Uint8Array }[] = []
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new ContractError('INVALID_WORKFLOW_PROFILE', [`Skill resource symlink is not supported: ${absolute}`])
    if (entry.isDirectory()) files.push(...await filesUnder(root, absolute))
    else if (entry.isFile()) files.push({ path: normalizedRelative(root, absolute), content: await readFile(absolute) })
  }
  return files
}

function declaredResources(content: string): string[] {
  return [...content.matchAll(localReference)].map((match) => match[1]).filter((path): path is string => path !== undefined)
}

export class FileSkillResolver {
  private readonly roots: string[]
  private readonly repositoryRoot: string

  constructor(options: SkillResolverOptions) {
    if (options.roots.length === 0) throw new ContractError('INVALID_WORKFLOW_PROFILE', ['at least one Skill root is required'])
    this.roots = options.roots.map((root) => resolve(root))
    this.repositoryRoot = resolve(options.repositoryRoot ?? process.cwd())
  }

  async resolve(reference: string): Promise<ResolvedSkill> {
    if (reference.startsWith('/') || reference.includes('\\') || reference.split('/').includes('..')) throw new ContractError('PLANNED_SKILL_MISSING', [`invalid Skill reference: ${reference}`])
    const candidates = reference.endsWith('/SKILL.md')
      ? [resolve(this.repositoryRoot, reference)]
      : this.roots.map((root) => resolve(root, reference, 'SKILL.md'))
    let skillPath: string | undefined
    for (const candidate of candidates) {
      const root = reference.endsWith('/SKILL.md') ? this.repositoryRoot : this.roots.find((item) => isInside(item, candidate))
      if (!root || !isInside(root, candidate)) continue
      try {
        await stat(candidate)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error && error.code === 'ENOENT')) throw error
        continue
      }
      if (!isInside(await realpath(root), await realpath(candidate))) throw new ContractError('INVALID_WORKFLOW_PROFILE', ['Skill symlink escapes root'])
      skillPath = candidate
      break
    }
    if (skillPath === undefined) throw new ContractError('PLANNED_SKILL_MISSING', [`${reference}: SKILL.md not found`])
    const skillDirectory = dirname(skillPath)
    const content = await readFile(skillPath)
    const resources = (await filesUnder(skillDirectory, skillDirectory)).filter((resource) => resource.path !== 'SKILL.md')
    for (const declared of declaredResources(content.toString('utf8'))) {
      const target = resolve(skillDirectory, declared)
      if (!isInside(skillDirectory, target)) throw new ContractError('INVALID_WORKFLOW_PROFILE', [`Skill resource escapes Skill directory: ${declared}`])
      try {
        if (!(await stat(target)).isFile()) throw new Error('not a file')
      } catch {
        throw new ContractError('PLANNED_SKILL_MISSING', [`${reference}: missing resource ${declared}`])
      }
    }
    const root = this.roots.find((item) => isInside(item, skillPath)) ?? this.repositoryRoot
    const frontmatter = content.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    let name = basename(skillDirectory)
    if (frontmatter) {
      const document = parseDocument(frontmatter[1], { uniqueKeys: true })
      if (document.errors.length) throw new ContractError('INVALID_WORKFLOW_PROFILE', document.errors.map((error) => error.message))
      const metadata = document.toJS({ maxAliasCount: 0 })
      if (!metadata || typeof metadata.name !== 'string' || !metadata.name.trim()) throw new ContractError('INVALID_WORKFLOW_PROFILE', ['Skill front matter requires a name'])
      name = metadata.name
    }
    return {
      name,
      path: normalizedRelative(root, skillPath),
      content,
      resources,
      source_commit: null,
    }
  }

  async load(snapshot: SkillSnapshot): Promise<string> {
    const candidates = [...this.roots, this.repositoryRoot].map((root) => ({ root, path: resolve(root, snapshot.path) }))
    for (const { root, path } of candidates) {
      if (!isInside(root, path)) throw new ContractError('RESOURCE_DRIFT', ['frozen Skill path escapes root'])
      let content: Buffer
      try { content = await readFile(path) }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
        continue
      }
      const resources = (await filesUnder(dirname(path), dirname(path)))
        .filter((resource) => resource.path !== 'SKILL.md')
        .map((resource) => ({ path: resource.path, sha256: sha256(resource.content), bytes: resource.content.byteLength }))
        .sort((a, b) => a.path.localeCompare(b.path))
      if (sha256(content) !== snapshot.digest || digestJson(resources) !== digestJson(snapshot.resources)) throw new ContractError('RESOURCE_DRIFT', [`frozen Skill changed: ${snapshot.path}`])
      return content.toString('utf8')
    }
    throw new ContractError('PLANNED_SKILL_MISSING', [snapshot.path])
  }
}
