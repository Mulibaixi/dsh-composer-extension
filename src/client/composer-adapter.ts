import type { Context } from '@deepseek-ai/cordis'
import type {
  Capability,
  ComposerExtensionService,
  ComposerSubmissionAdapter,
  ComposerSubmissionGesture,
  PreparedComposerContribution,
} from '../shared/contracts.js'

export interface NativeComposerSubmissions {
  readonly protocolVersion?: number
  register(
    owner: Context,
    contribution: { freeze(gesture: ComposerSubmissionGesture): PreparedComposerContribution | undefined },
  ): () => void
}

export class ComposerExtensionClientService implements ComposerExtensionService {
  private readonly registrations = new Map<string, () => void>()
  private disposed = false

  constructor(private readonly submissions: NativeComposerSubmissions | undefined) {}

  capabilities(): Capability {
    if (this.disposed) return { state: 'unavailable', version: null, reason: 'composer_extension_disposed' }
    if (!this.submissions || typeof this.submissions.register !== 'function') return { state: 'unavailable', version: null, reason: 'composer_submissions_unavailable' }
    const version = this.submissions.protocolVersion
    if (version === 1) return { state: 'available', version, reason: null }
    return version === undefined
      ? { state: 'unknown', version: null, reason: 'composer_protocol_undeclared' }
      : { state: 'unavailable', version, reason: 'composer_protocol_unsupported' }
  }

  register(owner: Context, adapter: ComposerSubmissionAdapter): () => void {
    const capability = this.capabilities()
    if (capability.state !== 'available') throw new Error(capability.reason ?? 'composer_protocol_unavailable')
    if (adapter.key.trim() === '') throw new Error('composer_adapter_key_required')
    if (this.registrations.has(adapter.key)) throw new Error(`composer_adapter_already_registered:${adapter.key}`)

    const unregister = this.submissions!.register(owner, {
      freeze: gesture => adapter.freeze(Object.freeze({ ...gesture })),
    })
    let active = true
    const dispose = () => {
      if (!active) return
      active = false
      this.registrations.delete(adapter.key)
      unregister()
    }
    this.registrations.set(adapter.key, dispose)
    owner.effect(() => () => dispose(), `composer-extension:${adapter.key}`)
    return dispose
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unregister of this.registrations.values()) unregister()
  }
}
