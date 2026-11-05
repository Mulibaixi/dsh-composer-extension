import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
for (const path of ['dist/host/index.js', 'dist/client.js']) await readFile(new URL(path, root))
const sourceHelper = await readFile(new URL('scripts/apply-host-patch.ps1', root))
const bundledHelper = await readFile(new URL('dist/host-patch-helper.ps1', root))
if (sha(sourceHelper) !== sha(bundledHelper)) throw new Error('请先构建最新的退出安装助手。')
const builds = (await readdir(new URL('dist/host-patches/', root), { withFileTypes: true })).filter(entry => entry.isDirectory())
if (!builds.length) throw new Error('请先生成宿主补丁产物。')
for (const build of builds) {
  const directory = new URL(`dist/host-patches/${build.name}/`, root)
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'))
  if (manifest.dshVersion !== build.name || manifest.composerProtocol !== 1 || ![3, 4].includes(manifest.files?.length)) throw new Error(`${build.name} 联动补丁产物清单无效。`)
  for (const file of manifest.files) {
    if (!/^[\w.-]+\.js$/.test(file.file) || sha(await readFile(new URL(file.file, directory))) !== file.sha256) throw new Error('请先生成并核验补丁产物。')
  }
}
console.log('分发构建、退出安装助手与补丁产物检查通过。')
