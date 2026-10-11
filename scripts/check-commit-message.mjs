import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = process.argv[2]
if (!file) throw new Error('请提供提交信息文件路径。')
const [header = '', , ...body] = readFileSync(resolve(file), 'utf8').replace(/\r\n?/gu, '\n').split('\n')
const errors = []
if (!/^(feat|fix|docs|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9]+(?:-[a-z0-9]+)*\))?!?: \S.*$/u.test(header)) errors.push('标题须符合 Conventional Commits 并包含中文描述。')
if ([...header].length > 72) errors.push('标题最多 72 个 Unicode 字符。')
if (!/\p{Script=Han}/u.test(header)) errors.push('标题描述使用中文。')
if (/[。.]$/u.test(header)) errors.push('标题不以句号结尾。')
if (body.some(line => line.trim()) && !body.join('\n').match(/\p{Script=Han}/u)) errors.push('正文使用中文。')
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
