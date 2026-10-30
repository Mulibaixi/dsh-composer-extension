import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {
  parseDomainResult,
  parseExchangeCapabilities,
  parseExchangeRequest,
  parseExchangeView,
} from './exchange-codec.js'
import { parseHostPatchStatus } from './host-patch.js'

export const PACKAGE_NAME = 'dsh-composer-extension'
const methods = ['capabilities', 'query', 'cancel'] as const

function parseResult(method: typeof methods[number], value: unknown): unknown {
  if (method === 'capabilities') return parseDomainResult(value, parseExchangeCapabilities)
  return parseDomainResult(value, parseExchangeView)
}

export const PLUGIN_REMOTE: TypertRemoteContribution = {
  package: PACKAGE_NAME,
  descriptors: methods.map(method => ({
    id: `${PACKAGE_NAME}#translationExchange/${method}`,
    service: 'translationExchange',
    namespace: 'translationExchange',
    method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'capabilities' ? [] : [{
      name: 'request',
      wire: 'request',
      source: 'json' as const,
      codec: {
        mode: 'strict' as const,
        typeSymbol: `${PACKAGE_NAME}#${method}Request`,
        create: () => ({ parse: parseExchangeRequest }),
      },
    }],
    result: {
      mode: 'strict' as const,
      typeSymbol: `${PACKAGE_NAME}#${method}Result`,
      create: () => ({ parse: (value: unknown) => parseResult(method, value) }),
    },
  })),
}

export const HOST_PATCH_REMOTE: TypertRemoteContribution = {
  package: PACKAGE_NAME,
  descriptors: (['status', 'recheck', 'restore', 'confirm', 'useNative'] as const).map(method => ({
    id: `${PACKAGE_NAME}#composerHostPatch/${method}`,
    service: 'composerHostPatch',
    namespace: 'composerHostPatch',
    method,
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: {
      mode: 'strict' as const,
      typeSymbol: `${PACKAGE_NAME}#HostPatchStatus`,
      create: () => ({ parse: parseHostPatchStatus }),
    },
  })),
}
