import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = await realpath(resolve(project, 'src'))
const entry = resolve(sourceRoot, 'client/index.ts')
const pkg = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'))
const modules = new Map()
const platformExternals = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives'])

function idOf(path) {
  const id = relative(sourceRoot, path)
  if (isAbsolute(id) || id === '..' || id.startsWith(`..${sep}`)) throw new Error('Client source escaped src')
  return id.split(sep).join('/')
}

function dependencies(source, id) {
  const parsed = ts.createSourceFile(id, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const found = new Set()
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const arg = node.arguments[0]
      if (node.arguments.length !== 1 || !arg || !ts.isStringLiteral(arg)) throw new Error(`Nonliteral require in ${id}`)
      found.add(arg.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return [...found].sort()
}

async function collect(path) {
  const actual = await realpath(path)
  const id = idOf(actual)
  if (modules.has(id)) return id
  const result = ts.transpileModule(await readFile(actual, 'utf8'), {
    fileName: actual,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, removeComments: true },
  })
  const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => project,
    getCanonicalFileName: file => file,
    getNewLine: () => '\n',
  }))
  const compiled = { body: result.outputText.trimEnd(), dependencies: {} }
  modules.set(id, compiled)
  for (const specifier of dependencies(compiled.body, id)) {
    if (platformExternals.has(specifier)) continue
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`Client external is not supported: ${specifier}`)
    let target = resolve(dirname(actual), specifier)
    const extension = extname(target)
    if (extension === '.js') target = target.slice(0, -3) + '.ts'
    else if (!extension) target += '.ts'
    else if (extension !== '.ts') throw new Error(`Client source is not supported: ${specifier}`)
    compiled.dependencies[specifier] = await collect(target)
  }
  return id
}

const entryId = await collect(entry)
const rows = [...modules.entries()].sort(([a], [b]) => a.localeCompare(b))
const factories = rows.map(([id, module]) => `      ${JSON.stringify(id)}: function(exports, require, module) {\n${module.body.split(/\r?\n/).map(line => `        ${line}`).join('\n')}\n      }`).join(',\n')
const dependencyMap = Object.fromEntries(rows.map(([id, module]) => [id, module.dependencies]))
const output = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(pkg.name)},`,
  '  factory: function(require) {',
  '    const modules = {', factories, '    };',
  `    const dependencyMap = ${JSON.stringify(dependencyMap)};`,
  '    const cache = Object.create(null);',
  '    function load(id) {',
  '      if (Object.hasOwn(cache, id)) return cache[id].exports;',
  '      const module = { exports: {} };',
  '      cache[id] = module;',
  '      const localRequire = name => {',
  ...[...platformExternals].map(specifier => `        if (name === ${JSON.stringify(specifier)}) return require(${JSON.stringify(specifier)});`),
  '        const target = dependencyMap[id]?.[name];',
  '        if (!target) throw new Error("Unknown Client dependency: " + name);',
  '        return load(target);',
  '      };',
  '      modules[id](module.exports, localRequire, module);',
  '      return module.exports;',
  '    }',
  `    return load(${JSON.stringify(entryId)});`,
  '  }',
  '});',
  '',
].join('\n')
await mkdir(resolve(project, 'dist'), { recursive: true })
await writeFile(resolve(project, 'dist/client.js'), output, 'utf8')
