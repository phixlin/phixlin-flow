import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { initialize } from '../../src/operations/init.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'phixlin-init-'))
  roots.push(root)
  return root
}

describe('初始化配置目录', () => {
  it.each(['project', 'user'])('%s 级在所选目录生成配置与 Codex 入口，保留已有文件', async (scope) => {
    const project = await directory()
    const user = await directory()
    const target = scope === 'project' ? project : user
    const other = scope === 'project' ? user : project
    const args = ['--scope', scope]
    const output = await initialize(args, project, user)
    expect(await readdir(target)).toEqual(['.agents', '.phixlin'])
    expect(await readdir(other)).toEqual([])
    expect(await readdir(join(target, '.phixlin'))).toEqual(['codex', 'workflows'])
    expect(await readFile(output.workflow, 'utf8')).toBe(await readFile('examples/workflows/with-skills.yaml', 'utf8'))
    expect(await readFile(output.prompt, 'utf8')).toContain('phixlin start')
    expect(await readFile(output.prompt, 'utf8')).toContain('不得在没有有效 operation 或工作流停止时直接实现')
    const entry = await readFile(output.entry, 'utf8')
    expect(parse(entry.split('---')[1])).toMatchObject({ name: 'phixlin', description: expect.any(String) })
    expect(await readdir(join(target, '.agents/skills'))).toEqual(['phixlin'])
    await writeFile(output.entry, '用户自定义入口\n')
    await writeFile(output.workflow, '用户自定义配置\n')
    await initialize(args, project, user)
    expect(await readFile(output.workflow, 'utf8')).toBe('用户自定义配置\n')
    expect(await readFile(output.entry, 'utf8')).toBe('用户自定义入口\n')
  })

  it('默认初始化当前项目', async () => {
    const project = await directory()
    const user = await directory()
    await initialize([], project, user)
    expect(await readdir(project)).toEqual(['.agents', '.phixlin'])
    expect(await readdir(user)).toEqual([])
  })

  it.each([['--scope'], ['--scope', 'invalid'], ['--unknown'], ['--scope', 'user', 'extra']])('拒绝无效参数 %j 且不产生文件', async (...args) => {
    const project = await directory()
    const user = await directory()
    await expect(initialize(args, project, user)).rejects.toThrow('用法')
    expect(await readdir(project)).toEqual([])
    expect(await readdir(user)).toEqual([])
  })

  it('文件系统错误直接失败', async () => {
    const project = await directory()
    const user = await directory()
    await writeFile(join(project, '.phixlin'), '不是目录')
    await expect(initialize([], project, user)).rejects.toThrow()
  })
})
