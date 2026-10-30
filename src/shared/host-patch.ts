export type HostPatchState = 'checking' | 'unsupported' | 'installed' | 'applied' | 'preparing' | 'pending' | 'failed' | 'restore_pending' | 'restored'

export interface HostPatchStatus {
  readonly state: HostPatchState
  readonly dshVersion: string | null
  readonly message: string
  readonly canRestore: boolean
}

export interface HostPatchService {
  status(): Promise<HostPatchStatus>
  recheck(): Promise<HostPatchStatus>
  restore(): Promise<HostPatchStatus>
  confirm(): Promise<HostPatchStatus>
  useNative(): Promise<HostPatchStatus>
}

declare module '@deepseek-ai/cordis' {
  interface Context { composerHostPatch: HostPatchService }
}

const states: readonly HostPatchState[] = ['checking', 'unsupported', 'installed', 'applied', 'preparing', 'pending', 'failed', 'restore_pending', 'restored']

export function parseHostPatchStatus(value: unknown): HostPatchStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_host_patch_status')
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  if (keys.length !== 4 || keys.some(key => !['state', 'dshVersion', 'message', 'canRestore'].includes(key)) ||
    !states.includes(row.state as HostPatchState) ||
    !(row.dshVersion === null || typeof row.dshVersion === 'string' && row.dshVersion.length > 0 && row.dshVersion.length <= 80) ||
    typeof row.message !== 'string' || row.message.length > 2000 || typeof row.canRestore !== 'boolean') {
    throw new Error('invalid_host_patch_status')
  }
  return { state: row.state as HostPatchState, dshVersion: row.dshVersion as string | null, message: row.message, canRestore: row.canRestore }
}
