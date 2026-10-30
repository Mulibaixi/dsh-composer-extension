import type { Context } from '@deepseek-ai/cordis'
import type { ComposerExtensionService } from '../shared/contracts.js'
import { parseHostPatchStatus, type HostPatchService, type HostPatchStatus } from '../shared/host-patch.js'

declare function require(moduleName: string): unknown

type Disposer = () => void
type Timer = ReturnType<typeof setTimeout>

type HostPatchRemotePort = { readonly [Method in keyof HostPatchService]: () => Promise<unknown> }

export function adaptHostPatchRemote(remote: HostPatchRemotePort): HostPatchService {
  const invoke = async (method: keyof HostPatchService): Promise<HostPatchStatus> => {
    const result = await remote[method]() as { readonly ok?: boolean; readonly value?: unknown }
    if (typeof result !== 'object' || result === null || result.ok !== true) throw new Error('host_patch_remote_unavailable')
    return parseHostPatchStatus(result.value)
  }
  return { status: () => invoke('status'), recheck: () => invoke('recheck'), restore: () => invoke('restore'), confirm: () => invoke('confirm') }
}

export interface HostPatchClientView {
  readonly status: HostPatchStatus
  readonly busy: boolean
  readonly open: boolean
  readonly notice: { readonly text: string; readonly success: boolean; readonly sequence: number } | null
}

/** Maintenance state only; no translation content or submission is owned here. */
export class HostPatchClient {
  private statusValue: HostPatchStatus = { state: 'checking', dshVersion: null, message: '正在检测联动组件…', canRestore: false }
  private busy = false
  private opened = false
  private disposed = false
  private sequence = 0
  private notice: HostPatchClientView['notice'] = null
  private lastNotice = ''
  private timer: Timer | undefined
  private pollCount = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly remote: HostPatchService, private readonly composer: Pick<ComposerExtensionService, 'capabilities'>) {}

  getSnapshot(): HostPatchClientView {
    return { status: this.statusValue, busy: this.busy, open: this.opened, notice: this.notice }
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  message(): string {
    const state = this.statusValue.state
    if (state === 'installed' || state === 'applied') {
      return this.composer.capabilities().state === 'available'
        ? '联动组件已就绪。'
        : '联动组件已更新，请完全退出并重新打开 DSH。'
    }
    return this.statusValue.message
  }

  open(): void {
    if (this.disposed) return
    this.opened = true
    this.emit()
    void this.refresh()
  }

  close(): void { this.opened = false; this.emit() }
  dismissNotice(): void { this.notice = null; this.emit() }

  async refresh(action: 'status' | 'recheck' | 'restore' = 'status'): Promise<void> {
    if (this.disposed || this.busy) return
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    if (action !== 'status') this.pollCount = 0
    this.busy = true
    this.emit()
    let confirmed = false
    try {
      let status = parseHostPatchStatus(await this.remote[action]())
      if (this.disposed) return
      if (status.state === 'applied' && this.composer.capabilities().state === 'available') {
        status = parseHostPatchStatus(await this.remote.confirm())
        if (this.disposed) return
        confirmed = status.state === 'installed'
      }
      this.statusValue = status
      const needsRestart = (status.state === 'installed' || status.state === 'applied') && this.composer.capabilities().state !== 'available'
      if (confirmed) this.showNotice('联动组件已更新。', true)
      else if (status.state === 'pending' || status.state === 'restore_pending' || status.state === 'failed' || needsRestart) this.showNotice(this.message(), false)
      if ((status.state === 'checking' || status.state === 'preparing') && this.pollCount++ < 120) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh() }, 1000)
      }
    } catch {
      if (this.disposed) return
      this.statusValue = { ...this.statusValue, state: 'failed', message: '无法读取联动组件状态，请重新检测。' }
      this.showNotice(this.statusValue.message, false)
    } finally {
      if (!this.disposed) { this.busy = false; this.emit() }
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.listeners.clear()
  }

  private showNotice(text: string, success: boolean): void {
    const key = `${this.statusValue.state}:${text}`
    if (key === this.lastNotice) return
    this.lastNotice = key
    this.notice = { text, success, sequence: ++this.sequence }
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}

interface ReactApi {
  createElement(type: unknown, props: Readonly<Record<string, unknown>> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void]
  useEffect(effect: () => void | Disposer, dependencies: readonly unknown[]): void
}

interface MaintenanceUiContext extends Context {
  readonly commandUi: { register(contribution: {
    readonly name: string
    label(): string
    description(): string
    available(): boolean
    readonly ui: { readonly kind: 'action'; run(): void }
  }): Disposer }
  readonly slots: {
    inject(name: string, register: () => Disposer): Disposer
    register(target: { readonly name: string; readonly id: string }, component: () => unknown): Disposer
  }
}

/** Uses the host application's React, Modal and Toast rather than bundling another runtime. */
export function registerHostPatchUi(ctx: Context, client: HostPatchClient): void {
  const react = require('react') as ReactApi
  const { Modal, Toast } = require('@deepseek-ai/dsh-client-ui-primitives') as { readonly Modal: unknown; readonly Toast: unknown }
  const h = react.createElement
  ctx.inject(['slots', 'commandUi'], scope => {
    const ui = scope as MaintenanceUiContext
    const Overlay = (): unknown => {
      const [, redraw] = react.useState(0)
      react.useEffect(() => client.subscribe(() => redraw(value => value + 1)), [])
      const view = client.getSnapshot()
      const mutating = view.busy || view.status.state === 'preparing' || view.status.state === 'checking'
      const footer = h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
        h('button', { type: 'button', disabled: mutating, onClick: () => { void client.refresh('recheck') } }, '重新检测'),
        view.status.canRestore ? h('button', { type: 'button', disabled: mutating || view.status.state === 'restore_pending', onClick: () => { void client.refresh('restore') } }, '恢复本次补丁前版本') : null,
        h('button', { type: 'button', onClick: () => client.close() }, '关闭'),
      )
      return h('div', null,
        h(Modal, { open: view.open, onClose: () => client.close(), title: 'Composer：联动组件维护', closeLabel: '关闭', footer },
          view.status.dshVersion ? h('p', null, `DSH ${view.status.dshVersion}`) : null,
          h('p', { role: view.status.state === 'failed' ? 'alert' : 'status' }, client.message()),
        ),
        view.notice ? h(Toast, { key: view.notice.sequence, text: view.notice.text, ...(view.notice.success ? { tone: 'success' } : {}), holdMs: 6000,
          onDone: () => client.dismissNotice(), actions: [{ label: '查看', onClick: () => { client.dismissNotice(); client.open() } }] }) : null,
      )
    }
    ui.effect(() => ui.slots.inject('shell.overlay', () => ui.slots.register({ name: 'shell.overlay', id: 'composer-extension.host-patch' }, Overlay)), 'composer host patch overlay')
    ui.effect(() => ui.commandUi.register({
      name: 'composer-maintenance', label: () => 'Composer：联动组件维护', description: () => '查看联动组件、重新检测或恢复宿主补丁。',
      available: () => true, ui: { kind: 'action', run: () => client.open() },
    }), 'composer host patch command')
  })
}
