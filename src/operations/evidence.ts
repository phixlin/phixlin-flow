import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { stringify } from 'yaml'
import { sha256 } from '../contracts/digest.js'
import { parseChangeStateYaml } from '../contracts/validation.js'
import { FileEvidenceStore } from '../runtime/evidence.js'
import type { ArtifactRef, ChangeState } from '../contracts/types.js'

export type EvidenceKind = 'state' | 'workflow' | 'event' | 'handoff' | 'report' | 'artifact'
export interface EvidenceFile { path: string; sha256: string; bytes: number; kind: EvidenceKind }
export interface EvidenceManifest { schema: 'phixlin.evidence-manifest.v1'; change_id: string; state_version: number; generated_at: string; files: EvidenceFile[] }

function artifactKind(trail: string[]): EvidenceKind {
  const joined = trail.join('.')
  if (joined.includes('history')) return 'event'
  if (joined.includes('candidate')) return 'handoff'
  if (joined.includes('verification') || joined.includes('finalization')) return 'report'
  return 'artifact'
}

function collectArtifactRefs(value: unknown): Map<string, { ref: ArtifactRef; kind: EvidenceKind }> {
  const found = new Map<string, { ref: ArtifactRef; kind: EvidenceKind }>()
  const visit = (item: unknown, trail: string[]): void => {
    if (Array.isArray(item)) { item.forEach((child, index) => visit(child, [...trail, String(index)])); return }
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    if (typeof record.path === 'string' && record.path.startsWith('artifacts/') && typeof record.sha256 === 'string' && typeof record.bytes === 'number') {
      const previous = found.get(record.path)
      const kind = artifactKind(trail)
      if (!previous || previous.kind === 'artifact') found.set(record.path, { ref: record as unknown as ArtifactRef, kind })
      return
    }
    for (const [key, child] of Object.entries(record)) visit(child, [...trail, key])
  }
  visit(value, [])
  return found
}

function fileRecord(path: string, bytes: Uint8Array, kind: EvidenceKind): EvidenceFile {
  return { path, sha256: sha256(bytes), bytes: bytes.length, kind }
}

export async function exportEvidenceBundle(state: ChangeState, changeRoot: string, outputPath: string): Promise<EvidenceManifest> {
  const output = resolve(outputPath)
  await mkdir(output, { recursive: false })
  const evidence = new FileEvidenceStore(changeRoot)
  const pending = [...collectArtifactRefs(state).values()]
  const copied = new Map<string, EvidenceFile>()
  while (pending.length > 0) {
    const item = pending.shift()!
    if (copied.has(item.ref.path)) continue
    const content = await evidence.read(item.ref)
    const bytes = Buffer.from(content)
    await mkdir(dirname(join(output, item.ref.path)), { recursive: true })
    await writeFile(join(output, item.ref.path), bytes, { flag: 'wx' })
    copied.set(item.ref.path, fileRecord(item.ref.path, bytes, item.kind))
    try { pending.push(...collectArtifactRefs(JSON.parse(content)).values()) }
    catch { /* 非 JSON 工件没有可递归导出的引用。 */ }
  }
  const stateBytes = Buffer.from(stringify(state))
  const workflowBytes = Buffer.from(`${JSON.stringify(state.workflow, null, 2)}\n`)
  await writeFile(join(output, 'flow-state.yaml'), stateBytes, { flag: 'wx' })
  await writeFile(join(output, 'workflow.json'), workflowBytes, { flag: 'wx' })
  const files = [fileRecord('flow-state.yaml', stateBytes, 'state'), fileRecord('workflow.json', workflowBytes, 'workflow'), ...copied.values()].sort((a, b) => a.path.localeCompare(b.path))
  const manifest: EvidenceManifest = { schema: 'phixlin.evidence-manifest.v1', change_id: state.change_id, state_version: state.state_version, generated_at: new Date().toISOString(), files }
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  return manifest
}

function validateManifest(value: unknown): EvidenceManifest {
  if (!value || typeof value !== 'object') throw new Error('审计包 manifest.json 必须是对象')
  const manifest = value as Partial<EvidenceManifest>
  if (manifest.schema !== 'phixlin.evidence-manifest.v1' || typeof manifest.change_id !== 'string' || !Number.isSafeInteger(manifest.state_version) || typeof manifest.generated_at !== 'string' || !Array.isArray(manifest.files)) throw new Error('审计包 manifest.json 不符合 v1 契约')
  const paths = new Set<string>()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || file.path === 'manifest.json' || posix.normalize(file.path) !== file.path || file.path.startsWith('../') || file.path.startsWith('/') || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !['state', 'workflow', 'event', 'handoff', 'report', 'artifact'].includes(file.kind)) throw new Error('审计包 manifest.json 包含非法文件记录')
    if (paths.has(file.path)) throw new Error(`审计包 manifest.json 包含重复路径：${file.path}`)
    paths.add(file.path)
  }
  if (!paths.has('flow-state.yaml') || !paths.has('workflow.json')) throw new Error('审计包缺少状态或 Workflow 索引')
  return manifest as EvidenceManifest
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) result.push(...await listFiles(root, path))
    else if (entry.isFile()) result.push(relative(root, path).split('\\').join('/'))
    else throw new Error(`审计包包含不支持的文件类型：${relative(root, path)}`)
  }
  return result.sort()
}

export async function verifyEvidenceBundle(bundlePath: string) {
  const root = resolve(bundlePath)
  const manifest = validateManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')))
  const expected = ['manifest.json', ...manifest.files.map((file) => file.path)].sort()
  const actual = await listFiles(root)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`审计包文件集合不匹配：期望 ${expected.join(', ')}；实际 ${actual.join(', ')}`)
  const nestedReferences = new Set<string>()
  for (const file of manifest.files) {
    const bytes = await readFile(join(root, file.path))
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`审计包文件校验失败：${file.path}`)
    if (file.path.startsWith('artifacts/')) {
      try { for (const path of collectArtifactRefs(JSON.parse(bytes.toString('utf8'))).keys()) nestedReferences.add(path) }
      catch { /* 非 JSON 工件没有可递归校验的引用。 */ }
    }
  }
  const state = parseChangeStateYaml(await readFile(join(root, 'flow-state.yaml'), 'utf8'))
  if (state.change_id !== manifest.change_id || state.state_version !== manifest.state_version) throw new Error('审计包状态与 manifest 标识不一致')
  const workflow = JSON.parse(await readFile(join(root, 'workflow.json'), 'utf8')) as unknown
  if (JSON.stringify(workflow) !== JSON.stringify(state.workflow)) throw new Error('审计包 Workflow 与状态快照不一致')
  const listed = new Set(manifest.files.map((file) => file.path))
  for (const { ref } of collectArtifactRefs(state).values()) if (!listed.has(ref.path)) throw new Error(`审计包未索引状态引用：${ref.path}`)
  for (const path of nestedReferences) if (!listed.has(path)) throw new Error(`审计包未索引嵌套引用：${path}`)
  return { valid: true, change_id: manifest.change_id, state_version: manifest.state_version, files: manifest.files.length }
}
