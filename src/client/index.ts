import type { Context } from '@deepseek-ai/cordis'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { HOST_PATCH_REMOTE, PLUGIN_REMOTE } from '../shared/plugin-remote.js'
import type { ComposerExtensionService } from '../shared/contracts.js'
import { ComposerExtensionClientService, type NativeComposerSubmissions } from './composer-adapter.js'
import { adaptHostPatchRemote, HostPatchClient, registerHostPatchUi } from './host-patch.js'

declare module '@deepseek-ai/cordis' {
  interface Context { composerExtension: ComposerExtensionService }
}

type PatchedConversation = IConversation & { readonly submissions: NativeComposerSubmissions }

export const name = 'dsh-composer-extension-client'
export const inject = ['remote', 'conversation'] as const

export { ComposerExtensionClientService } from './composer-adapter.js'

export async function apply(ctx: Context): Promise<void> {
  const conversation = ctx.conversation as PatchedConversation
  const composer = new ComposerExtensionClientService(conversation.submissions)
  ctx.provide('composerExtension', composer)
  ctx.effect(() => () => composer.dispose(), 'dsh-composer-extension.composer')

  let disposed = false
  let unmount: (() => void | Promise<void>) | undefined
  ctx.effect(() => async () => { disposed = true; await unmount?.() }, 'dsh-composer-extension.remote')
  const mounted = await ctx.remote.$mount({ package: PLUGIN_REMOTE.package, descriptors: [...PLUGIN_REMOTE.descriptors, ...HOST_PATCH_REMOTE.descriptors] })
  if (disposed) { await mounted(); return }
  unmount = mounted

  try {
    const port = ctx.get('remote.composerHostPatch') as Parameters<typeof adaptHostPatchRemote>[0]
    const maintenance = new HostPatchClient(adaptHostPatchRemote(port), composer)
    ctx.effect(() => () => maintenance.dispose(), 'dsh-composer-extension.host-patch')
    registerHostPatchUi(ctx, maintenance)
    void maintenance.refresh()
  } catch (error) {
    if (!disposed) console.warn('[dsh-composer-extension] 联动组件维护暂不可用。', error)
  }
}
