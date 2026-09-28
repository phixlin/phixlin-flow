import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileEvidenceStore, HarnessEvidenceBoundary, parseChangeStateYaml } from '../../src/index.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'phixlin-host-check-'))
  roots.push(root)
  const state = parseChangeStateYaml(await readFile('fixtures/state/verify.yaml', 'utf8'))
  const evidence = new FileEvidenceStore(root)
  const boundary = new HarnessEvidenceBoundary({ evidence, cwd: root })
  return { root, state, evidence, boundary }
}

describe('宿主可信机器检查', () => {
  it.each(['codex', 'codex.cmd', 'codex.exe', 'claude', 'C:\\tools\\claude.cmd'])('拒绝将 %s 当成机器检查启动', async (command) => {
    const { state, boundary } = await setup()
    state.shape!.checks = [{ id: 'agent', argv: [command, 'exec'], cwd: '.', timeout_ms: 1000 }]
    await expect(boundary.runChecks({ operationId: 'op', executionRef: 'ref', state, action: 'run-checks' })).rejects.toThrow('机器检查不能启动底层 Agent CLI')
  })

  it('机器检查捕获真实退出码和报告，而不是信任宿主声明', async () => {
    const { state, evidence, boundary } = await setup()
    state.shape!.checks = [
      { id: 'pass', argv: [process.execPath, '-e', 'process.stdout.write("checked")'], cwd: '.', timeout_ms: 5000 },
      { id: 'fail', argv: [process.execPath, '-e', 'process.exit(7)'], cwd: '.', timeout_ms: 5000 },
    ]
    const result = await boundary.runChecks({ operationId: 'op', executionRef: 'ref', state, action: 'run-checks' })
    expect(result.checks?.map((check) => [check.result, check.exit_code])).toEqual([['pass', 0], ['fail', 7]])
    expect(await evidence.read(result.checks![0]!.report!)).toContain('checked')
  })

  it('机器检查启动失败时给出命令、目录和恢复建议', async () => {
    const { state, boundary } = await setup()
    state.shape!.checks = [{ id: 'missing', argv: ['phixlin-command-that-does-not-exist'], cwd: '.', timeout_ms: 1000 }]
    await expect(boundary.runChecks({ operationId: 'op', executionRef: 'ref', state, action: 'run-checks' })).rejects.toThrow(/启动命令失败.*phixlin-command-that-does-not-exist.*cwd=.*status.*blocked/)
  })

  it('候选采集的 Git 失败时指出具体阶段', async () => {
    const { state, boundary } = await setup()
    state.outer.phase = 'build'
    await expect(boundary.bindResult({ operationId: 'op', executionRef: 'ref', state, action: 'agent-work' }, {
      kind: 'stage-ready', summary: '完成', questions: [], proposal: null, shape: null, review: null, verification: null,
    })).rejects.toThrow(/采集工作区状态失败：git status；cwd=/)
  })
})
