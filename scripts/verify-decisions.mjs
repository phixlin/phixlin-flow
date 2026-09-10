#!/usr/bin/env node
// 校验 docs/decisions/:索引与文件一一对应、文件名规范、编号连续。
import { readdirSync, readFileSync } from 'node:fs'

const dir = 'docs/decisions'
const readme = readFileSync(`${dir}/README.md`, 'utf8')
const indexed = [...readme.matchAll(/\| (\d{4})-/g)].map((m) => m[1])
const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
const errors = []

for (const n of new Set(indexed))
  if (!files.some((f) => f.startsWith(n))) errors.push(`索引有 ${n} 但文件缺失`)
for (const f of files) {
  if (!/^\d{4}-[a-z0-9-]+\.md$/.test(f)) errors.push(`文件名格式错误: ${f}`)
  if (!indexed.includes(f.slice(0, 4))) errors.push(`文件未入索引: ${f}`)
}
const nums = files.map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b)
for (let i = 0; i < nums.length - 1; i++)
  if (nums[i + 1] - nums[i] !== 1) errors.push(`编号不连续: ${nums[i]} -> ${nums[i + 1]}`)

if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log(`ok: ${files.length} decision files`)
