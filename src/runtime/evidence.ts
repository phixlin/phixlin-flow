import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { sha256 } from '../contracts/digest.js'
import { ContractError } from '../contracts/error.js'
import type { ArtifactRef } from '../contracts/types.js'

/** Immutable, content-addressed evidence; readers verify bytes before consuming them. */
export class FileEvidenceStore {
  constructor(private readonly root: string) {}

  async write(content: string): Promise<ArtifactRef> {
    const bytes = Buffer.from(content)
    const digest = sha256(bytes)
    return this.writeArtifact({ path: `artifacts/${digest}.json`, sha256: digest, bytes: bytes.length }, bytes)
  }

  async writeNamed(name: 'verification.md' | 'delivery-summary.json' | 'knowledge.md' | 'artifact-index.json', content: string): Promise<ArtifactRef> {
    const bytes = Buffer.from(content)
    const digest = sha256(bytes)
    return this.writeArtifact({ path: `artifacts/${digest}/${name}`, sha256: digest, bytes: bytes.length }, bytes)
  }

  private async writeArtifact(artifact: ArtifactRef, bytes: Buffer): Promise<ArtifactRef> {
    const path = join(this.root, artifact.path)
    await mkdir(dirname(path), { recursive: true })
    let handle
    try { handle = await open(path, 'wx') }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      await this.read(artifact)
      return artifact
    }
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally { await handle.close() }
    return artifact
  }

  async read(artifact: ArtifactRef): Promise<string> {
    if (!artifact.path.startsWith('artifacts/') || posix.normalize(artifact.path) !== artifact.path || artifact.path.includes('\\')) throw new ContractError('INVALID_EXECUTION_RESULT', ['invalid evidence path'])
    const bytes = await readFile(join(this.root, artifact.path))
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new ContractError('RESOURCE_DRIFT', [`evidence changed: ${artifact.path}`])
    return bytes.toString('utf8')
  }
}
