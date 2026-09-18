import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexRuntimeAdapter, FileEvidenceStore, parseChangeStateYaml } from '../../src/index.js'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'phixlin-codex-'))
  roots.push(root)
  await exec('git', ['init', '-q'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await exec('git', ['config', 'user.name', 'Test'], { cwd: root })
  await writeFile(join(root, 'tracked.txt'), 'before\n')
  await exec('git', ['add', 'tracked.txt'], { cwd: root })
  await exec('git', ['commit', '-qm', 'baseline'], { cwd: root })
  const changeRoot = join(root, '.phixlin', 'changes', 'change')
  await mkdir(changeRoot, { recursive: true })
  const state = parseChangeStateYaml(await readFile('fixtures/state/build.yaml', 'utf8'))
  state.workspace.root = root
  state.shape!.checks = [
    { id: 'pass', argv: [process.execPath, '-e', 'process.exit(0)'], cwd: '.', timeout_ms: 5_000 },
    { id: 'fail', argv: [process.execPath, '-e', 'process.exit(7)'], cwd: '.', timeout_ms: 5_000 },
  ]
  const command = resolve('fixtures/fake-codex.sh')
  await chmod(command, 0o755)
  return { root, state, evidence: new FileEvidenceStore(changeRoot), command }
}

async function executable(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, source)
  await chmod(path, 0o755)
  return path
}

describe.skipIf(process.platform === 'win32')('CodexRuntimeAdapter 的宿主证据', () => {
  it('拒绝空脱敏值', async () => {
    const { root, evidence } = await setup()
    expect(() => new CodexRuntimeAdapter({ evidence, cwd: root, sensitiveValues: [''] })).toThrow('不能包含空字符串')
  })

  it('从真实工作区采集 Build 候选及未跟踪文件摘要', async () => {
    const { root, state, evidence, command } = await setup()
    await writeFile(join(root, 'tracked.txt'), 'after\n')
    await writeFile(join(root, 'new.txt'), 'new\n')
    const adapter = new CodexRuntimeAdapter({ evidence, cwd: root, command })
    const result = await adapter.execute({ operationId: 'op', executionRef: 'exec', state, action: 'agent-work' })
    expect(result.candidate?.candidate_digest).toBe(result.candidate?.file_manifest.sha256)
    const manifest = JSON.parse(await evidence.read(result.candidate!.file_manifest))
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(['new.txt', 'tracked.txt'])
    expect(await evidence.read(result.candidate!.diff)).toContain('tracked.txt')
  })

  it('由宿主执行检查并保留真实退出码', async () => {
    const { root, state, evidence, command } = await setup()
    state.outer.phase = 'verify'
    const adapter = new CodexRuntimeAdapter({ evidence, cwd: root, command })
    const result = await adapter.execute({ operationId: 'op', executionRef: 'exec', state, action: 'run-checks' })
    expect(result.checks?.map(({ result, exit_code }) => [result, exit_code])).toEqual([['pass', 0], ['fail', 7]])
    expect(JSON.parse(await evidence.read(result.checks![1]!.report!)).exit_code).toBe(7)
  })

  it.each([
    ['非零退出', '#!/bin/sh\nexit 7\n', 5_000, 'Codex exited with code 7'],
    ['损坏输出', '#!/bin/sh\nprintf not-json\n', 5_000, 'Codex returned no structured result'],
    ['超时', '#!/bin/sh\nsleep 1\n', 10, 'Codex execution timed out'],
  ])('将%s映射为 blocked', async (_name, source, timeoutMs, summary) => {
    const { root, state, evidence } = await setup()
    const command = await executable(root, 'fault.sh', source)
    const result = await new CodexRuntimeAdapter({ evidence, cwd: root, command, timeoutMs }).execute({ operationId: 'op', executionRef: 'exec', state, action: 'agent-work' })
    expect(result).toMatchObject({ kind: 'blocked', summary })
  })

  it('在结果和事件工件中脱敏已配置值', async () => {
    const { root, state, evidence } = await setup()
    const command = await executable(root, 'secret.sh', '#!/bin/sh\nprintf \'%s\\n\' \'{"kind":"stage-ready","summary":"token-secret","questions":[],"proposal":null,"shape":null,"review":null,"verification":null}\'\n')
    const result = await new CodexRuntimeAdapter({ evidence, cwd: root, command, sensitiveValues: ['token-secret'] }).execute({ operationId: 'op', executionRef: 'exec', state, action: 'skill' })
    expect(result.summary).toBe('[REDACTED]')
    expect(await evidence.read(result.artifacts[0])).not.toContain('token-secret')
  })

  it('读取嵌套 result 和 item text 事件并忽略诊断行', async () => {
    const { root, state, evidence } = await setup()
    state.outer.phase = 'shape'
    state.inner = { state: 'ready', position: { action: 'agent-work', skill_index: null, turn: 0, attempt: 0 } }
    const shape = { document: '规格', acceptance: [], checks: [] }
    const item = JSON.stringify({ kind: 'stage-ready', summary: 'item', shape })
    const source = `#!/bin/sh\nprintf '%s\\n' 'diagnostic' '{"item":{"text":"not-json"}}' '${JSON.stringify({ item: { text: item } }).replaceAll("'", "'\\''")}' '${JSON.stringify({ result: { kind: 'stage-ready', summary: 'nested', shape } }).replaceAll("'", "'\\''")}'\n`
    const command = await executable(root, 'events.sh', source)
    const result = await new CodexRuntimeAdapter({ evidence, cwd: root, command }).execute({ operationId: 'op', executionRef: 'exec', state, action: 'agent-work' })
    expect(result.summary).toBe('nested')
    expect(await evidence.read(result.shape!.documents[0]!)).toBe('规格')
  })

  it('绑定 review 和 verification 到当前候选', async () => {
    const { root, evidence } = await setup()
    const state = parseChangeStateYaml(await readFile('fixtures/state/verify.yaml', 'utf8'))
    state.outer.status = 'active'
    state.interaction = null
    const reviewCommand = await executable(root, 'review.sh', '#!/bin/sh\nprintf \'%s\\n\' \'{"kind":"stage-ready","summary":"ok","review":{"verdict":"pass","report":"reviewed"}}\'\n')
    const review = await new CodexRuntimeAdapter({ evidence, cwd: root, command: reviewCommand }).execute({ operationId: 'op', executionRef: 'exec', state, action: 'review-candidate' })
    expect(review.review).toMatchObject({ candidate_id: state.candidate!.candidate_id, verdict: 'pass' })
    expect(await evidence.read(review.review!.report)).toBe('reviewed')

    const verifyCommand = await executable(root, 'verify.sh', '#!/bin/sh\nprintf \'%s\\n\' \'{"kind":"stage-ready","summary":"ok","verification":{"verdict":"pass","acceptance":[]}}\'\n')
    const verification = await new CodexRuntimeAdapter({ evidence, cwd: root, command: verifyCommand }).execute({ operationId: 'op', executionRef: 'exec', state, action: 'verify-candidate' })
    expect(verification.verification).toMatchObject({ candidate_digest: state.candidate!.candidate_digest, verdict: 'pass' })
  })

  it('在无结构化结果时附加 stderr', async () => {
    const { root, state, evidence } = await setup()
    const command = await executable(root, 'stderr.sh', '#!/bin/sh\nprintf error >&2\nprintf diagnostic\n')
    const result = await new CodexRuntimeAdapter({ evidence, cwd: root, command }).execute({ operationId: 'op', executionRef: 'exec', state, action: 'skill' })
    expect(result.summary).toBe('Codex returned no structured result: error')
  })

  it('拒绝在工作区外执行 Shape 检查', async () => {
    const { root, state, evidence, command } = await setup()
    state.outer.phase = 'verify'
    state.shape!.checks = [{ id: 'escape', argv: [process.execPath, '-e', ''], cwd: '..', timeout_ms: 100 }]
    await expect(new CodexRuntimeAdapter({ evidence, cwd: root, command }).execute({ operationId: 'op', executionRef: 'exec', state, action: 'run-checks' })).rejects.toThrow('检查 cwd 超出工作区')
  })

  it('将显式 skillInput 传入 skill 调用并处理空检查集', async () => {
    const { root, state, evidence, command } = await setup()
    const adapter = new CodexRuntimeAdapter({ evidence, cwd: root, command, sandbox: 'read-only' })
    const skill = await adapter.execute({ operationId: 'op', executionRef: 'exec', state, action: 'skill', skillInput: 'explicit input' })
    expect(skill.kind).toBe('stage-ready')
    state.shape!.checks = []
    const checks = await adapter.execute({ operationId: 'op', executionRef: 'exec', state, action: 'run-checks' })
    expect(checks.checks).toEqual([])
  })

  it('候选摘要包含已删除文件并拒绝非 Git 工作区', async () => {
    const { root, evidence, command } = await setup()
    await rm(join(root, 'tracked.txt'))
    const adapter = new CodexRuntimeAdapter({ evidence, cwd: root, command })
    await expect(adapter.inspectCandidate()).resolves.toHaveLength(64)

    const outside = await mkdtemp(join(tmpdir(), 'phixlin-not-git-'))
    roots.push(outside)
    await expect(new CodexRuntimeAdapter({ evidence, cwd: outside, command }).inspectCandidate()).rejects.toThrow('git status failed')
  })

  it('为不完整但结构化的 Shape 结果应用宿主默认值', async () => {
    const { root, state, evidence } = await setup()
    state.outer.phase = 'shape'
    state.inner = { state: 'ready', position: { action: 'agent-work', skill_index: null, turn: 0, attempt: 0 } }
    const command = await executable(root, 'defaults.sh', '#!/bin/sh\nprintf \'%s\\n\' \'{"kind":"stage-ready","questions":"invalid","shape":{}}\'\n')
    const result = await new CodexRuntimeAdapter({ evidence, cwd: root, command }).execute({ operationId: 'op', executionRef: 'exec', state, action: 'agent-work' })
    expect(result).toMatchObject({ summary: '', questions: [], proposal: null, shape: { acceptance: [], checks: [] } })
    expect(await evidence.read(result.shape!.documents[0]!)).toBe('')
  })
})
