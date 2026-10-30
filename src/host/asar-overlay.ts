import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

// Electron treats .asar paths as virtual directories, including in its Node mode.
// Work on archive bytes through original-fs without changing process.noAsar globally.
export const archiveFileSystem: typeof nodeFs = process.versions.electron
  ? createRequire(import.meta.url)('original-fs') as typeof nodeFs
  : nodeFs
const { createReadStream, createWriteStream } = archiveFileSystem
const { mkdir, open, readFile, rm, stat } = archiveFileSystem.promises

export interface HostPatchManifest {
  /** Build provenance; runtime compatibility is checked against target-module fingerprints. */
  readonly dshVersion: string
  readonly composerProtocol: 1
  readonly files: readonly {
    readonly archivePath: string
    readonly file: string
    readonly beforeSha256: readonly string[]
    readonly sha256: string
  }[]
}

interface ArchiveNode {
  files?: Record<string, ArchiveNode>
  size?: number
  offset?: string
  unpacked?: boolean
  link?: string
  integrity?: { algorithm: 'SHA256'; hash: string; blockSize: number; blocks: string[] }
}

export interface Archive {
  readonly tree: ArchiveNode
  readonly offset: number
  entry(path: string): ArchiveNode | undefined
  contents(path: string): Promise<Buffer>
  close(): Promise<void>
}

const packages = ['dsh-llm', 'dsh-api-session-controller', 'dsh-client-ui-conversation', 'dsh-client-ui-plugin-manager'] as const
const targets = packages.slice(1).map(name => `dsh/node_modules/@deepseek-ai/${name}/lib/client.js`)
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/u

async function readExact(file: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let read = 0
  while (read < bytes.length) {
    const result = await file.read(bytes, read, bytes.length - read, position + read)
    if (result.bytesRead === 0) throw new Error('安装归档内容不完整。')
    read += result.bytesRead
  }
}

export async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

export function encodeHeader(tree: ArchiveNode): Buffer {
  const json = Buffer.from(JSON.stringify(tree))
  const inner = Buffer.alloc(4 + Math.ceil((4 + json.length) / 4) * 4)
  inner.writeUInt32LE(inner.length - 4, 0)
  inner.writeUInt32LE(json.length, 4)
  json.copy(inner, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(inner.length, 4)
  return Buffer.concat([size, inner])
}

/** Read packed entries without Electron's filesystem interception or an ASAR dependency. */
export async function readArchive(path: string): Promise<Archive> {
  const file = await open(path, 'r')
  try {
    const length = (await file.stat()).size, prefix = Buffer.alloc(16)
    await readExact(file, prefix, 0)
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12), offset = 8 + headerSize
    if (prefix.readUInt32LE(0) !== 4 || prefix.readUInt32LE(8) !== headerSize - 4
      || jsonSize === 0 || jsonSize > headerSize - 8 || offset > length) throw new Error('安装归档头无效。')
    const json = Buffer.alloc(jsonSize)
    await readExact(file, json, 16)
    const tree = JSON.parse(json.toString('utf8')) as ArchiveNode
    if (!tree || typeof tree !== 'object' || !tree.files) throw new Error('安装归档目录无效。')
    const entry = (name: string): ArchiveNode | undefined => {
      const parts = name.split('/')
      if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('归档路径无效。')
      let node: ArchiveNode | undefined = tree
      for (const part of parts) node = node?.files && Object.hasOwn(node.files, part) ? node.files[part] : undefined
      return node
    }
    return {
      tree, offset, entry,
      async contents(name) {
        const node = entry(name), start = Number(node?.offset)
        if (!node || node.unpacked || node.link || !Number.isSafeInteger(node.size) || node.size! < 0
          || !Number.isSafeInteger(start) || start < 0 || node.size! > length - offset - start) {
          throw new Error(`归档文件不可读取：${name}`)
        }
        const bytes = Buffer.alloc(node.size!)
        await readExact(file, bytes, offset + start)
        return bytes
      },
      close: () => file.close(),
    }
  } catch (error) { await file.close(); throw error }
}

function checkManifest(manifest: HostPatchManifest): void {
  if (!manifest || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(manifest.dshVersion)
    || manifest.composerProtocol !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== targets.length) {
    throw new Error('联动补丁清单无效。')
  }
  const found = new Set<string>()
  for (const file of manifest.files) {
    if (!targets.includes(file.archivePath) || found.has(file.archivePath)
      || typeof file.file !== 'string' || basename(file.file) !== file.file || file.file.includes('\\')
      || !file.file.endsWith('.js') || !hashPattern.test(file.sha256)
      || !Array.isArray(file.beforeSha256) || !file.beforeSha256.length
      || file.beforeSha256.some((hash: unknown) => typeof hash !== 'string' || !hashPattern.test(hash))) throw new Error('联动补丁文件清单无效。')
    found.add(file.archivePath)
  }
}

async function inspect(input: Archive, manifest: HostPatchManifest, artifactDir: string): Promise<{ installed: boolean; dshVersion: string }> {
  checkManifest(manifest)
  let dshVersion = ''
  for (const name of packages) {
    const metadata = JSON.parse((await input.contents(`dsh/node_modules/@deepseek-ai/${name}/package.json`)).toString('utf8')) as { version?: unknown }
    if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(metadata.version)) throw new Error(`无法识别宿主模块版本：${name}。`)
    if (dshVersion && metadata.version !== dshVersion) throw new Error(`宿主模块版本不一致：${name} 应为 ${dshVersion}，实际为 ${metadata.version}。`)
    dshVersion = metadata.version
  }
  let installed = true
  for (const artifact of manifest.files) {
    const bytes = await readFile(join(artifactDir, artifact.file))
    if (sha(bytes) !== artifact.sha256) throw new Error(`联动补丁产物校验失败：${artifact.file}`)
    const current = sha(await input.contents(artifact.archivePath))
    if (current === artifact.sha256) continue
    if (!artifact.beforeSha256.includes(current)) throw Object.assign(new Error(`当前安装文件与已适配版本不一致：${artifact.archivePath}`), { code: 'host_patch_mismatch' })
    installed = false
  }
  return { installed, dshVersion }
}

export async function inspectOverlay(archivePath: string, manifest: HostPatchManifest, artifactDir: string): Promise<{ installed: boolean; dshVersion: string }> {
  const input = await readArchive(archivePath)
  try { return await inspect(input, manifest, artifactDir) }
  finally { await input.close() }
}

/** Append only replacement modules; all pre-existing payload bytes and other entries remain intact. */
export async function prepareOverlay(archivePath: string, outputPath: string, manifest: HostPatchManifest, artifactDir: string): Promise<{
  alreadyApplied: boolean
  baseSha256: string
  candidateSha256: string
}> {
  archivePath = resolve(archivePath); outputPath = resolve(outputPath)
  if (archivePath.toLowerCase() === outputPath.toLowerCase()) throw new Error('候选包不能覆盖正在读取的安装包。')
  const baseSha256 = await fileHash(archivePath), input = await readArchive(archivePath)
  let started = false
  try {
    if ((await inspect(input, manifest, artifactDir)).installed) return { alreadyApplied: true, baseSha256, candidateSha256: baseSha256 }
    let nextOffset = (await stat(archivePath)).size - input.offset
    const parts: Buffer[] = []
    for (const artifact of manifest.files) {
      const bytes = await readFile(join(artifactDir, artifact.file)), node = input.entry(artifact.archivePath)!
      if (sha(bytes) !== artifact.sha256) throw new Error(`联动补丁产物校验失败：${artifact.file}`)
      if (sha(await input.contents(artifact.archivePath)) === artifact.sha256) continue
      node.offset = String(nextOffset); node.size = bytes.length
      const blockSize = 4 * 1024 * 1024, blocks: string[] = []
      for (let start = 0; start < bytes.length; start += blockSize) blocks.push(sha(bytes.subarray(start, start + blockSize)))
      node.integrity = { algorithm: 'SHA256', hash: artifact.sha256, blockSize, blocks }
      parts.push(bytes); nextOffset += bytes.length
    }
    await mkdir(dirname(outputPath), { recursive: true })
    const headerOutput = await open(outputPath, 'wx')
    started = true
    try { await headerOutput.writeFile(encodeHeader(input.tree)) } finally { await headerOutput.close() }
    await pipeline(createReadStream(archivePath, { start: input.offset }), createWriteStream(outputPath, { flags: 'a' }))
    const output = await open(outputPath, 'a')
    try { for (const bytes of parts) await output.writeFile(bytes) } finally { await output.close() }
    if (await fileHash(archivePath) !== baseSha256) throw new Error('安装文件在准备期间发生变化，已取消本次补丁。')
    const verified = await inspectOverlay(outputPath, manifest, artifactDir)
    if (!verified.installed) throw new Error('候选安装包校验失败。')
    return { alreadyApplied: false, baseSha256, candidateSha256: await fileHash(outputPath) }
  } catch (error) {
    if (started) await rm(outputPath, { force: true })
    throw error
  } finally { await input.close() }
}
