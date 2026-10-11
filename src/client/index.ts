import type { Context } from '@deepseek-ai/cordis'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { PLUGIN_REMOTE } from '../shared/plugin-remote.js'
import type { ComposerExtensionService } from '../shared/contracts.js'
import { ComposerExtensionClientService, type NativeComposerSubmissions } from './composer-adapter.js'

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
  const mounted = await ctx.remote.$mount(PLUGIN_REMOTE)
  if (disposed) await mounted()
  else unmount = mounted
}
