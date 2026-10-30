import type { Context } from '@deepseek-ai/cordis'
import { execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { HostPatchService, HostPatchStatus } from '../shared/host-patch.js'
import { PACKAGE_NAME } from '../shared/plugin-remote.js'
import { archiveFileSystem, fileHash, inspectOverlay, prepareOverlay, readArchive, type HostPatchManifest } from './asar-overlay.js'

const { copyFile, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } = archiveFileSystem.promises

export interface DesktopInstallation {
  readonly archivePath: string
  readonly executablePath: string
  readonly runtimeDir: string
  readonly dataDir: string
}

interface PatchJob {
  readonly id: string
  readonly operation: 'install' | 'restore'
  readonly dshVersion: string
  readonly archivePath: string
  readonly executablePath: string
  readonly hostPid: number
  readonly desktopPid: number
  readonly baseSha256: string
  readonly candidatePath: string
  readonly candidateSha256: string
  readonly backupPath: string
  readonly permitPath: string
  readonly resultPath: string
  readonly helperPid?: number
}

interface PatchResult {
  readonly id: string
  readonly state: 'applied' | 'failed' | 'cancelled' | 'restored'
  readonly message: string
}

interface PatchRecord { readonly path: string; readonly job: PatchJob; readonly result: PatchResult | null }

interface HostPatchOptions {
  readonly installation: DesktopInstallation | null
  readonly confirmEnabled: () => Promise<boolean>
  readonly confirmSelected?: () => Promise<boolean>
  readonly artifactsRoot?: string
  readonly helperSource?: string
  readonly launchHelper?: (jobPath: string, helperPath: string) => ChildProcess
}

const outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const emptyStatus = (): HostPatchStatus => ({ state: 'checking', dshVersion: null, message: '正在检查联动组件…', canRestore: false })

async function json(path: string): Promise<unknown> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}

async function launchPatchHelper(jobPath: string, helperPath: string): Promise<number> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`
  const argumentsText = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helperPath}" -JobPath "${jobPath}"`
  // PowerShell 5.1 needs a console: Node's DETACHED_PROCESS can silently skip the script.
  // Start-Process creates an independent hidden process and returns the real worker PID.
  const command = `$ErrorActionPreference = 'Stop'; $worker = Start-Process -FilePath ${literal(executable)} -ArgumentList ${literal(argumentsText)} -WindowStyle Hidden -PassThru; $worker.Id`
  const { stdout } = await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { windowsHide: true, timeout: 15000, maxBuffer: 4096 })
  const pid = Number(stdout.trim())
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) throw new Error('无法取得安装助手进程编号。')
  return pid
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return isAbsolute(path) && part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** Only packaged Windows Desktop has an installation this extension can maintain. */
export async function findDesktopInstallation(profileName: string | undefined): Promise<DesktopInstallation | null> {
  if (process.platform !== 'win32' || profileName !== 'desktop' || process.env.ELECTRON_RUN_AS_NODE !== '1') return null
  const runtimeDir = process.argv[2]
  const localData = process.env.LOCALAPPDATA
  if (!runtimeDir || !localData || !/\.asar[\\/]dsh$/i.test(runtimeDir)) return null
  const archivePath = resolve(runtimeDir.slice(0, -4))
  const executablePath = await realpath(process.execPath)
  if (archivePath.toLowerCase() !== resolve(dirname(executablePath), 'resources', 'app.asar').toLowerCase()) return null
  const key = createHash('sha256').update(archivePath.toLowerCase()).digest('hex').slice(0, 20)
  return { archivePath, executablePath, runtimeDir, dataDir: join(localData, PACKAGE_NAME, 'host-patches', key) }
}

/** Disk installation and the currently loaded Client capability are deliberately separate. */
export class ComposerHostPatchService implements HostPatchService {
  readonly typertRemote: { readonly service: ComposerHostPatchService; readonly serviceKey: 'composerHostPatch'; readonly namespace: 'composerHostPatch' } =
    { service: this, serviceKey: 'composerHostPatch', namespace: 'composerHostPatch' }
  private snapshot = emptyStatus()
  private running: Promise<void> | undefined
  private disposed = false
  private shuttingDown = false
  private closePermission: Promise<boolean> | undefined
  private current: PatchRecord | null = null
  private child: ChildProcess | undefined
  private readonly onMessage = (value: unknown): void => {
    if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'shutdown') {
      this.shuttingDown = true
      this.closePermission ??= this.options.confirmEnabled().catch(() => false)
    }
  }

  constructor(readonly ctx: Context, private readonly options: HostPatchOptions) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'composerHostPatch', property: 'ctx' } })
    if (options.installation) process.on('message', this.onMessage)
  }

  start(): Promise<void> { return this.check(false) }
  async status(): Promise<HostPatchStatus> {
    if (!this.disposed && !this.running && !this.child && this.current?.job.helperPid && !this.current.result &&
      ['pending', 'restore_pending'].includes(this.snapshot.state)) {
      try { process.kill(this.current.job.helperPid, 0) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await this.helperStopped(this.current.job) }
    }
    return { ...this.snapshot }
  }

  async recheck(): Promise<HostPatchStatus> {
    if (!this.disposed && !this.running) void this.check(true)
    return this.status()
  }

  async confirm(): Promise<HostPatchStatus> {
    if (!this.disposed && this.snapshot.state === 'applied' && this.current?.result?.state === 'applied') {
      await writeJson(join(dirname(this.current.path), 'confirmed.json'), { id: this.current.job.id })
      this.snapshot = { ...this.snapshot, state: 'installed', message: '联动组件已安装。' }
      await this.removeCandidate(this.current.job)
      await this.cleanOlderJobs(dirname(this.current.path))
    }
    return this.status()
  }

  /** The Client has verified the native submissions protocol; no replacement is needed. */
  async useNative(): Promise<HostPatchStatus> {
    await this.running
    if (this.disposed || this.current?.result || this.current?.job.operation === 'restore') return this.status()
    if (this.current) { await this.cancelRecord(this.current); await this.removeCandidate(this.current.job); this.current = null }
    this.snapshot = { state: 'installed', dshVersion: this.snapshot.dshVersion, message: '当前宿主已提供联动能力，无需安装补丁。', canRestore: false }
    return this.status()
  }

  async restore(): Promise<HostPatchStatus> {
    if (this.disposed || this.running || !this.snapshot.canRestore || !this.current) return this.status()
    const record = this.current
    this.running = this.prepareRestore(record).catch(error => this.failed(error)).finally(() => { this.running = undefined })
    return this.status()
  }

  private failed(error: unknown): void {
    this.snapshot = { ...this.snapshot, state: 'failed', message: `联动组件维护未完成：${messageOf(error)}`.slice(0, 2000) }
  }

  private check(force: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.running) return this.running
    this.snapshot = emptyStatus()
    this.running = this.inspectAndPrepare(force).catch(error => this.failed(error)).finally(() => { this.running = undefined })
    return this.running
  }

  private async inspectAndPrepare(force: boolean): Promise<void> {
    const installation = this.options.installation
    if (!installation) {
      this.snapshot = { state: 'unsupported', dshVersion: null, message: '自动安装适用于 Windows 桌面正式安装版；当前环境不修改宿主文件。', canRestore: false }
      return
    }
    const automaticRestore = await this.readRecord('uninstall.json')
    if (automaticRestore) {
      if (!automaticRestore.result) await this.cancelRecord(automaticRestore)
      await this.removeCandidate(automaticRestore.job)
      await rm(join(installation.dataDir, 'uninstall.json'), { force: true })
    }
    const archive = await readArchive(installation.archivePath)
    let version: string
    try {
      const metadata = JSON.parse((await archive.contents('dsh/node_modules/@deepseek-ai/dsh-llm/package.json')).toString('utf8')) as { version?: unknown }
      if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('无法识别当前 DSH 版本。')
      version = metadata.version
    } finally { await archive.close() }
    this.snapshot = { ...this.snapshot, dshVersion: version }
    const artifactsRoot = this.options.artifactsRoot ?? join(outputRoot, 'host-patches')
    const builds = await readdir(artifactsRoot, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const candidates = [...new Set([version, ...builds.filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(entry.name)).map(entry => entry.name)])]
    let matched: { artifactDir: string; manifest: HostPatchManifest; inspection: { installed: boolean; dshVersion: string } } | undefined
    for (const build of candidates) {
      const artifactDir = join(artifactsRoot, build)
      let manifest: HostPatchManifest
      try { manifest = await json(join(artifactDir, 'manifest.json')) as HostPatchManifest }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      try {
        matched = { artifactDir, manifest, inspection: await inspectOverlay(installation.archivePath, manifest, artifactDir) }
        break
      } catch (error) { if ((error as { code?: string }).code !== 'host_patch_mismatch') throw error }
    }
    if (!matched) {
      this.snapshot = { state: 'unsupported', dshVersion: version, message: '当前宿主模块尚无匹配的自动补丁产物，请更新 Composer 扩展；已有联动能力可继续使用。', canRestore: false }
      return
    }
    const { artifactDir, manifest, inspection } = matched
    const previous = await this.readRecord()
    if (previous && !previous.result) await this.cancelRecord(previous)
    if (previous && (!previous.result || previous.result.state === 'cancelled' || previous.result.state === 'failed')) await this.removeCandidate(previous.job)
    this.current = previous
    const currentHash = previous?.result ? await fileHash(installation.archivePath) : null
    const resultMatches = previous && previous.job.dshVersion === version && previous.result
    const restoredHash = previous?.job.operation === 'restore' ? previous.job.candidateSha256 : previous?.job.baseSha256
    if (resultMatches && previous.result!.state === 'restored' && currentHash === restoredHash && !force) {
      this.snapshot = { state: 'restored', dshVersion: version, message: '已恢复补丁前版本；点击“重新检测”可重新安排安装。', canRestore: false }
      await this.removeCandidate(previous.job)
      await this.cleanOlderJobs(dirname(previous.path))
      return
    }
    if (inspection.installed) {
      const canRestore = !!(resultMatches && previous.result!.state === 'applied' && currentHash === previous.job.candidateSha256 && await this.hasBackup(previous.job))
      const acknowledged = previous ? await this.isConfirmed(previous) : true
      this.snapshot = { state: canRestore && !acknowledged ? 'applied' : 'installed', dshVersion: version, message: '联动组件已安装。', canRestore }
      if (acknowledged && previous) { await this.removeCandidate(previous.job); await this.cleanOlderJobs(dirname(previous.path)) }
      return
    }
    if (resultMatches && previous.result!.state === 'failed' && currentHash === previous.job.baseSha256 && !force) {
      this.snapshot = { state: 'failed', dshVersion: version, message: previous.result!.message.slice(0, 2000), canRestore: false }
      return
    }
    if (this.disposed) return
    this.snapshot = { state: 'preparing', dshVersion: version, message: '正在准备联动组件…', canRestore: false }
    await mkdir(installation.dataDir, { recursive: true })
    const directory = join(installation.dataDir, randomUUID())
    await mkdir(directory)
    const candidate = join(directory, 'candidate.asar')
    const prepared = await prepareOverlay(installation.archivePath, candidate, manifest, artifactDir)
    if (this.disposed || prepared.alreadyApplied) {
      await rm(candidate, { force: true })
      if (!this.disposed) this.snapshot = { state: 'installed', dshVersion: version, message: '联动组件已安装。', canRestore: false }
      return
    }
    await this.arrange({ directory, version, baseSha256: prepared.baseSha256, candidatePath: candidate, candidateSha256: prepared.candidateSha256, operation: 'install' })
  }

  private async prepareRestore(record: PatchRecord, automaticRestore = false): Promise<void> {
    const installation = this.options.installation!
    this.snapshot = { ...this.snapshot, state: 'preparing', message: '正在准备恢复联动组件…' }
    if (!await this.hasBackup(record.job) || await fileHash(installation.archivePath) !== record.job.candidateSha256) throw new Error('当前安装或备份已变化，未安排恢复。')
    const directory = join(installation.dataDir, randomUUID())
    await mkdir(directory, { recursive: true })
    const candidatePath = join(directory, 'candidate.asar')
    await copyFile(record.job.backupPath, candidatePath)
    if (await fileHash(candidatePath) !== record.job.baseSha256) throw new Error('恢复候选校验失败。')
    if (automaticRestore && await this.options.confirmSelected?.()) { await rm(candidatePath, { force: true }); return }
    if (this.disposed && !automaticRestore) { await rm(candidatePath, { force: true }); return }
    await this.arrange({ directory, version: record.job.dshVersion, baseSha256: record.job.candidateSha256, candidatePath, candidateSha256: record.job.baseSha256,
      operation: 'restore', automaticRestore, helperSource: join(dirname(record.path), 'apply-host-patch.ps1') })
  }

  private async arrange(input: { directory: string; version: string; baseSha256: string; candidatePath: string; candidateSha256: string; operation: 'install' | 'restore'; automaticRestore?: boolean; helperSource?: string }): Promise<void> {
    const installation = this.options.installation!
    const id = randomUUID()
    const path = join(input.directory, 'job.json')
    const helper = join(input.directory, 'apply-host-patch.ps1')
    await copyFile(input.helperSource ?? this.options.helperSource ?? join(outputRoot, 'host-patch-helper.ps1'), helper)
    const job: PatchJob = {
      id, operation: input.operation, dshVersion: input.version, archivePath: installation.archivePath, executablePath: installation.executablePath,
      hostPid: process.pid, desktopPid: process.ppid, baseSha256: input.baseSha256, candidatePath: input.candidatePath, candidateSha256: input.candidateSha256,
      backupPath: join(input.directory, 'before.asar'), permitPath: join(input.directory, 'permit.json'), resultPath: join(input.directory, 'result.json'),
    }
    await writeJson(path, job)
    await writeJson(join(installation.dataDir, input.automaticRestore ? 'uninstall.json' : 'current.json'), { jobPath: path })
    const record = { path, job, result: null }
    if (!input.automaticRestore) this.current = record
    if (this.disposed && !input.automaticRestore) { await this.cancelRecord(record); return }
    if (input.automaticRestore) await writeJson(job.permitPath, { id: job.id, allowed: true })
    const child = this.options.launchHelper?.(path, helper)
    this.child = child
    if (child) {
      child.once('error', error => { if (!this.disposed) this.failed(error); void writeJson(job.permitPath, { id: job.id, allowed: false }).catch(() => {}) })
      child.once('exit', (code, signal) => {
        if (this.disposed || this.current?.job.id !== id) return
        void this.helperStopped(job, code, signal).catch(error => this.failed(error))
      })
      child.unref()
    }
    const helperPid = child ? child.pid : await launchPatchHelper(path, helper)
    if (helperPid) { record.job = { ...job, helperPid }; await writeJson(path, record.job) }
    this.snapshot = { state: job.operation === 'restore' ? 'restore_pending' : 'pending', dshVersion: input.version,
      message: job.operation === 'restore' ? '恢复已准备，完全退出 DSH 后自动完成。' : '联动组件已准备，完全退出 DSH 后自动安装，重新打开生效。', canRestore: false }
  }

  private async readRecord(pointerName: 'current.json' | 'uninstall.json' = 'current.json'): Promise<PatchRecord | null> {
    const installation = this.options.installation!
    try {
      const pointer = await json(join(installation.dataDir, pointerName)) as { jobPath?: unknown }
      if (typeof pointer.jobPath !== 'string' || !within(installation.dataDir, pointer.jobPath)) return null
      const job = await json(pointer.jobPath) as PatchJob
      if (!job || typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(job.id) || job.archivePath !== installation.archivePath ||
        job.executablePath !== installation.executablePath || !['install', 'restore'].includes(job.operation) ||
        ![job.baseSha256, job.candidateSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
        ![job.candidatePath, job.backupPath, job.permitPath, job.resultPath].every(path => typeof path === 'string' && within(dirname(pointer.jobPath as string), path))) return null
      let result: PatchResult | null = null
      try {
        const value = await json(job.resultPath) as PatchResult
        if (value.id === job.id && ['applied', 'failed', 'cancelled', 'restored'].includes(value.state) && typeof value.message === 'string') result = value
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      return { path: pointer.jobPath, job, result }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  private async isConfirmed(record: PatchRecord): Promise<boolean> {
    try { return (await json(join(dirname(record.path), 'confirmed.json')) as { id?: unknown }).id === record.job.id }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }

  private async hasBackup(job: PatchJob): Promise<boolean> {
    try { return await fileHash(job.backupPath) === job.baseSha256 }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }

  private async removeCandidate(job: PatchJob): Promise<void> { await rm(job.candidatePath, { force: true }) }

  private async helperStopped(job: PatchJob, code?: number | null, signal?: NodeJS.Signals | null): Promise<void> {
    let result: PatchResult | null = null
    try { result = await json(job.resultPath) as PatchResult }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (this.current?.job.id !== job.id || this.disposed) return
    if (result?.id === job.id && (result.state === 'failed' || result.state === 'cancelled')) this.failed(result.message)
    else this.failed(`安装助手已退出${signal ? `（信号 ${signal}）` : code !== undefined ? `（退出码 ${String(code)}）` : ''}，未写入结果；请重新检测以安排安装。`)
  }

  private async cleanOlderJobs(keep: string): Promise<void> {
    const root = this.options.installation!.dataDir
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const directory = join(root, entry.name)
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name) || directory === keep) continue
      for (const file of ['candidate.asar', 'before.asar', 'apply-host-patch.ps1', 'job.json', 'result.json', 'permit.json', 'confirmed.json']) {
        await rm(join(directory, file), { force: true })
      }
      await rmdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error })
    }
  }

  private async cancelRecord(record: PatchRecord): Promise<void> {
    await writeJson(record.job.permitPath, { id: record.job.id, allowed: false })
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>(resolveWait => {
        const timer = setTimeout(done, 3000)
        const child = this.child!
        function done(): void { clearTimeout(timer); child.off('exit', done); resolveWait() }
        child.once('exit', done)
      })
    } else if (record.job.helperPid) {
      for (let attempt = 0; attempt < 30; attempt++) {
        try { process.kill(record.job.helperPid, 0) } catch { break }
        if (attempt === 29) throw new Error('旧安装助手尚未结束，请稍后重新检测。')
        await new Promise(resolveWait => setTimeout(resolveWait, 100))
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    const gracefulShutdown = this.shuttingDown
    this.disposed = true
    try {
      await this.running
      const record = this.current
      if (!record) return
      if (gracefulShutdown) {
        if (!record.result) {
          const allowed = await (this.closePermission ?? Promise.resolve(false))
          await writeJson(record.job.permitPath, { id: record.job.id, allowed })
        }
        return
      }
      // A persisted deselection distinguishes disable/uninstall from HMR reload.
      const selected = await (this.options.confirmSelected?.() ?? Promise.resolve(true))
      if (record.result) {
        if (!selected && record.job.operation === 'install' && record.result.state === 'applied') await this.prepareRestore(record, true)
        return
      }
      if (!selected && record.job.operation === 'restore') {
        await writeJson(record.job.permitPath, { id: record.job.id, allowed: true })
        return
      }
      await this.cancelRecord(record)
    } finally { process.off('message', this.onMessage) }
  }
}

interface ProfileFacts { readonly name: string; readonly installAnchor: string }
interface ComposedRow { readonly id: string; readonly name: string; readonly disabled?: unknown; readonly group?: boolean; readonly config?: unknown }

/** Read the persisted selection independently of a fiber being torn down. */
async function selectedExtension(profile: ProfileFacts | undefined, installation: DesktopInstallation): Promise<{ id: string; enabled: boolean } | null> {
  if (profile?.name !== 'desktop') return null
  const require = createRequire(join(installation.runtimeDir, 'package.json'))
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href) as {
    readProfilePatches(bin: string, profile: ProfileFacts): unknown[]
    composeEntries(patches: unknown[][]): ComposedRow[]
  }
  const matches: { id: string; enabled: boolean }[] = []
  const visit = (rows: ComposedRow[], enabled: boolean): void => {
    for (const row of rows) {
      const literal = row.disabled === undefined || row.disabled === null || typeof row.disabled === 'boolean'
      const active = enabled && literal && row.disabled !== true
      if (row.name === PACKAGE_NAME) matches.push({ id: row.id, enabled: active })
      if (row.group && Array.isArray(row.config)) visit(row.config as ComposedRow[], active)
    }
  }
  visit(boot.composeEntries([boot.readProfilePatches('dsh', profile)]), true)
  return matches.length === 1 && matches[0]?.enabled ? matches[0] : null
}

/** Re-read persistence at graceful shutdown, retaining the live row check for installation permission. */
export async function extensionStillEnabled(ctx: Context, installation: DesktopInstallation): Promise<boolean> {
  const profile = ctx.get('profileContext') as ProfileFacts | undefined
  const loader = ctx.get('loader') as { entries(): Iterable<{ readonly options: { id: string; name: string }; readonly disabled: boolean }> } | undefined
  if (!loader) return false
  const runtimeRows = [...loader.entries()].map(row => ({ id: row.options.id, name: row.options.name, disabled: row.disabled }))
  const match = await selectedExtension(profile, installation)
  if (!match) return false
  return runtimeRows.some(row => row.id === match.id && row.name === PACKAGE_NAME && row.disabled === false)
}

export async function createHostPatchService(ctx: Context): Promise<ComposerHostPatchService> {
  const profile = ctx.get('profileContext') as ProfileFacts | undefined
  let installation: DesktopInstallation | null = null
  try { installation = await findDesktopInstallation(profile?.name) }
  catch { /* An unavailable desktop environment must not stop the exchange service. */ }
  const located = installation
  return new ComposerHostPatchService(ctx, { installation,
    confirmEnabled: () => located ? extensionStillEnabled(ctx, located) : Promise.resolve(false),
    confirmSelected: async () => located ? !!await selectedExtension(profile, located) : true })
}
