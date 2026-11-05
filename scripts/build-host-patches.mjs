import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectOverlay, readArchive } from '../src/host/asar-overlay.ts'
import { patchDesktopMain } from './desktop-cookie-patch.mjs'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const packages = ['packages/api/session-controller', 'packages/client/ui-conversation', 'packages/client/ui-plugin-manager']

function argumentsOf(argv) {
  if (argv.includes('--help')) {
    console.log('Usage: node scripts/build-host-patches.mjs --source <DSH source> --archive <official app.asar> [--output <artifact root>] [--from-build]')
    console.log('Requires Node.js 22.19+ and the fixed DSH source tree with its build dependencies installed.')
    console.log('The source is patched in place. --from-build reuses its existing browser bundles after source checks.')
    console.log('Output: <artifact root>/<DSH version>/manifest.json, three client.js files and the Desktop startup fix where declared; default root: dist/host-patches.')
    return undefined
  }
  const result = { output: join(project, 'dist/host-patches'), fromBuild: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--from-build') { result.fromBuild = true; continue }
    if (!['--source', '--archive', '--output'].includes(arg)) throw new Error(`Unknown argument: ${arg}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`)
    result[arg.slice(2)] = resolve(value)
  }
  if (!result.source || !result.archive) throw new Error('Both --source and --archive are required; use --help.')
  return result
}

async function optionalBytes(path) {
  try { return await readFile(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

async function verifySource(source, manifest, patchPath) {
  const patch = await readFile(patchPath)
  if (sha(patch) !== manifest.patch.sha256) throw new Error('Source patch hash does not match its manifest.')
  // A source tarball may be inside this extension's ignored cache. Do not let
  // Git discover that parent worktree and silently skip all relative patches.
  const gitOptions = { cwd: source, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(source) } }
  const commit = spawnSync('git', ['rev-parse', '--show-toplevel'], gitOptions)
  if (commit.status === 0 && resolve(commit.stdout.trim()).toLowerCase() === source.toLowerCase()) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], gitOptions)
    if (head.status !== 0 || head.stdout.trim() !== manifest.upstreamCommit) throw new Error(`Source HEAD must be ${manifest.upstreamCommit}.`)
  }
  const states = await Promise.all(manifest.files.map(async entry => {
    const bytes = await optionalBytes(join(source, entry.path)), current = bytes === undefined ? null : sha(bytes)
    if (current === entry.patchedSha256) return 'patched'
    if (current === entry.upstreamSha256) return 'upstream'
    throw new Error(`Source differs from the fixed upstream and patch: ${entry.path}`)
  }))
  if (states.every(value => value === 'patched')) return
  // Existing Composer builds may already contain the submission patch while
  // a newly added copy fix is still upstream. Apply only the missing files.
  const includes = manifest.files.filter((entry, index) => states[index] === 'upstream').map(entry => `--include=${entry.path}`)
  for (const args of [['apply', '--check', patchPath], ['apply', patchPath]]) {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args, ...includes], gitOptions)
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not apply source patch.')
  }
  for (const entry of manifest.files) {
    if (sha(await readFile(join(source, entry.path))) !== entry.patchedSha256) throw new Error(`Patched source verification failed: ${entry.path}`)
  }
}

async function buildClients(source, version, commit) {
  const require = createRequire(join(source, 'package.json'))
  const ts = require('typescript'), { build } = await import(pathToFileURL(require.resolve('tsdown')).href)
  process.env.DSH_CLIENT_VERSION = version
  process.env.DSH_CLIENT_COMMIT_HASH = commit.slice(0, 7)
  process.env.DSH_CLIENT_GIT_DIRTY = 'true'
  const { clientBundle } = await import(pathToFileURL(join(source, 'packages/client/tsdown.client.ts')).href)
  for (const name of packages) {
    const directory = join(source, name)
    const walk = async folder => {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        const filename = join(folder, item.name)
        if (item.isDirectory()) { await walk(filename); continue }
        if (!/\.tsx?$/.test(item.name) || item.name.endsWith('.d.ts')) continue
        const result = ts.transpileModule(await readFile(filename, 'utf8'), { fileName: filename, reportDiagnostics: true,
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
            rewriteRelativeImportExtensions: true, sourceMap: true, inlineSources: true } })
        if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error(`Source transpilation failed: ${filename}`)
        const output = join(directory, 'lib/types', relative(join(directory, 'src'), filename).replace(/\.tsx?$/, '.js'))
        await mkdir(dirname(output), { recursive: true })
        await writeFile(output, result.outputText)
        if (result.sourceMapText) await writeFile(output + '.map', result.sourceMapText)
      }
    }
    await walk(join(directory, 'src'))
    const configurations = clientBundle(directory, [])({})
    for (const config of configurations.filter(config => config.platform === 'browser')) await build({ ...config, config: false, cwd: directory })
  }
}

async function main(options) {
  const metadata = JSON.parse(await readFile(join(options.source, 'package.json'), 'utf8')), version = metadata.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid DSH source version.')
  const sourceManifest = JSON.parse(await readFile(join(project, `patches/source-manifest-${version}.json`), 'utf8'))
  const baseline = JSON.parse(await readFile(join(project, `patches/host-baseline-${version}.json`), 'utf8'))
  if (baseline.dshVersion !== version || sourceManifest.upstreamTag !== `dsh-v${version}` || sourceManifest.composerProtocol !== 1) throw new Error('Source version and manifests disagree.')
  const archive = await readArchive(options.archive)
  let desktopMain
  try {
    for (const file of baseline.files) {
      const bytes = await archive.contents(file.archivePath)
      if (sha(bytes) !== file.upstreamSha256) throw new Error(`The --archive must be the official unmodified baseline: ${file.archivePath}`)
      if (file.archivePath === 'lib/main.js') desktopMain = bytes
    }
  } finally { await archive.close() }
  await verifySource(options.source, sourceManifest, join(project, 'patches', sourceManifest.patch.file))
  if (!options.fromBuild) await buildClients(options.source, version, sourceManifest.upstreamCommit)
  const output = join(options.output, version)
  await mkdir(output, { recursive: true })
  const files = []
  for (const [index, file] of baseline.files.entries()) {
    let bytes
    if (file.archivePath === 'lib/main.js') bytes = patchDesktopMain(desktopMain)
    else {
      const input = join(options.source, packages[index], 'lib/client.js')
      await access(input)
      // Virtual CSS module region labels contain absolute build paths. Remove
      // only grouping comments; retain code and dependency license notices.
      bytes = Buffer.from((await readFile(input, 'utf8')).replace(/^[\t ]*\/\/#(?:end)?region[^\r\n]*(?:\r?\n|$)/gm, ''))
      if (bytes.length === 0 || !bytes.toString('utf8').includes('__ModuleLoader__.load')) throw new Error(`Invalid browser client bundle: ${input}`)
    }
    await writeFile(join(output, file.file), bytes)
    files.push({ archivePath: file.archivePath, file: file.file,
      beforeSha256: [...new Set([file.upstreamSha256, ...file.knownPatchSha256])], sha256: sha(bytes) })
  }
  const manifest = { dshVersion: version, composerProtocol: 1, files }
  await inspectOverlay(options.archive, manifest, output)
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Host patch artifacts ready: ${output}`)
}

const options = argumentsOf(process.argv.slice(2))
if (options) await main(options)
