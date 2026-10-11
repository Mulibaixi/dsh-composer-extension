import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export function forbiddenStagedPaths(files) {
  return files.filter(file => /^(?:node_modules|dist|coverage|\.pnpm-store|internal|logs|data)\//u.test(file)
  || /(?:^|\/)(?:tests?|__tests__|fixtures|__fixtures__|__snapshots__|test-results|sdk-consumer)(?:\/|$)/u.test(file)
  || /(?:^|\/)[^/]+\.(?:test|spec|integration)(?:\.[^/]+)?$/u.test(file)
  || /^\.(?:cache|npm-cache)\//u.test(file)
  || /^scripts\/(?:check|prepare)-sdk-consumer\.mjs$/u.test(file)
  || /(?:^|\/)\.env(?:\.|$)/u.test(file) && !file.endsWith('/.env.example') && file !== '.env.example'
  || /\.(?:log|tgz|snap)(?:\.json)?$/u.test(file))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? result.stderr.trim())
    process.exitCode = 1
  } else {
    const rejected = forbiddenStagedPaths(result.stdout.split('\0').filter(Boolean))
    if (rejected.length) {
      console.error(`暂存区含禁止提交的资料，请移至仓库外或取消暂存：\n${rejected.join('\n')}`)
      process.exitCode = 1
    }
  }
}
