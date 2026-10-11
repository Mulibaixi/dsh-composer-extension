import {
  EXCHANGE_PROTOCOL,
  type Capability,
  type CapabilityKey,
  type DomainResult,
  type ExchangeCapabilities,
  type ExchangeError,
  type ExchangeResolution,
  type ExchangeRequest,
  type ExchangeScope,
  type ExchangeView,
  type RequestContextInput,
  type RequestContextQuestion,
} from './contracts.js'

const capabilityKeys: readonly CapabilityKey[] = ['composer', 'materialBridge', 'normal', 'exchange', 'modelControl']
const errorStages = ['authorize', 'prepare', 'protocol', 'notify', 'resolve', 'register_resume', 'dispatch', 'writeback'] as const
const encoder = new TextEncoder()

function object(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected object')
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new TypeError('Unexpected fields')
}

function text(value: unknown, maxBytes: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || encoder.encode(value).byteLength > maxBytes || !wellFormed(value) || value.includes('\0')) {
    throw new TypeError('Invalid text')
  }
}

function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function positive(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError('Invalid positive version')
}

function identity(value: unknown, maxBytes = 512): asserts value is string {
  text(value, maxBytes)
}

function parseQuestion(value: unknown, sourceLength: number): RequestContextQuestion {
  object(value)
  exact(value, ['type', 'range', 'question', 'reason'])
  if (!['missing_context', 'term_ambiguity', 'requirement_conflict'].includes(value.type as string)) throw new TypeError('Invalid question type')
  if (value.range !== null) {
    object(value.range)
    exact(value.range, ['start', 'end'])
    if (!Number.isSafeInteger(value.range.start) || !Number.isSafeInteger(value.range.end) ||
      (value.range.start as number) < 0 || (value.range.end as number) <= (value.range.start as number) ||
      (value.range.end as number) > sourceLength) throw new TypeError('Invalid source range')
  }
  text(value.question, 8192)
  text(value.reason, 8192)
  return {
    type: value.type as RequestContextQuestion['type'],
    range: value.range === null ? null : { start: value.range.start as number, end: value.range.end as number },
    question: value.question,
    reason: value.reason,
  }
}

export function parseRequestContextInput(value: unknown, sourceCodePointLength: number): RequestContextInput {
  if (!Number.isSafeInteger(sourceCodePointLength) || sourceCodePointLength < 0) throw new TypeError('Invalid source length')
  object(value)
  exact(value, ['questions'])
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) throw new TypeError('Expected one to three questions')
  const questions = value.questions.map(item => parseQuestion(item, sourceCodePointLength))
  const bytes = questions.reduce((sum, item) => sum + encoder.encode(item.question).byteLength + encoder.encode(item.reason).byteLength, 0)
  if (bytes > 8192) throw new TypeError('Question text exceeds 8 KiB')
  return { questions }
}

export function parseExchangeScope(value: unknown): ExchangeScope {
  object(value)
  exact(value, ['mainSessionId', 'topicId', 'translationSessionId', 'unitId', 'sourceVersion', 'operationId'])
  identity(value.mainSessionId); identity(value.topicId); identity(value.translationSessionId); identity(value.unitId); identity(value.operationId)
  positive(value.sourceVersion)
  return {
    mainSessionId: value.mainSessionId,
    topicId: value.topicId,
    translationSessionId: value.translationSessionId,
    unitId: value.unitId,
    sourceVersion: value.sourceVersion,
    operationId: value.operationId,
  }
}

export function parseExchangeResolution(value: unknown): ExchangeResolution {
  object(value)
  if (value.kind === 'answer') {
    exact(value, ['kind', 'answerText', 'organizedRequirements', 'references'])
    text(value.answerText, 40 * 1024, true); text(value.organizedRequirements, 40 * 1024, true)
    if (encoder.encode(value.answerText).byteLength + encoder.encode(value.organizedRequirements).byteLength > 32768) throw new TypeError('Answer exceeds 32 KiB')
    if (!value.answerText.trim() && !value.organizedRequirements.trim()) throw new TypeError('Answer is empty')
    if (!Array.isArray(value.references) || value.references.length > 32) throw new TypeError('Invalid references')
    const references = value.references.map((item: unknown) => {
      object(item)
      exact(item, ['id', 'version'])
      identity(item.id, 256); positive(item.version)
      return { id: item.id, version: item.version }
    })
    if (new Set(references.map(reference => reference.id)).size !== references.length) throw new TypeError('Duplicate resolution reference')
    if (encoder.encode(JSON.stringify({ ...value, references })).byteLength > 40 * 1024) throw new TypeError('Resolution exceeds 40 KiB')
    return { kind: 'answer', answerText: value.answerText, organizedRequirements: value.organizedRequirements, references }
  }
  if (value.kind === 'defer' || value.kind === 'abort') {
    exact(value, ['kind', 'reason'])
    text(value.reason, 4096, true)
    return { kind: value.kind, reason: value.reason }
  }
  throw new TypeError('Invalid resolution kind')
}

export function parseExchangeRequest(value: unknown): ExchangeRequest {
  object(value)
  exact(value, ['mainSessionId', 'translationSessionId', 'operationId', 'exchangeId', 'expectedVersion'])
  identity(value.mainSessionId); identity(value.translationSessionId); identity(value.operationId); identity(value.exchangeId)
  positive(value.expectedVersion)
  return {
    mainSessionId: value.mainSessionId,
    translationSessionId: value.translationSessionId,
    operationId: value.operationId,
    exchangeId: value.exchangeId,
    expectedVersion: value.expectedVersion,
  }
}

function parseCapability(value: unknown): Capability {
  object(value)
  exact(value, ['state', 'version', 'reason'])
  if (!['available', 'unavailable', 'unknown'].includes(value.state as string)) throw new TypeError('Invalid capability state')
  if (value.version !== null) positive(value.version)
  if (value.reason !== null) text(value.reason, 256)
  return { state: value.state as Capability['state'], version: value.version as number | null, reason: value.reason as string | null }
}

export function parseExchangeCapabilities(value: unknown): ExchangeCapabilities {
  object(value)
  exact(value, ['exchangeProtocol', 'capabilities'])
  if (value.exchangeProtocol !== EXCHANGE_PROTOCOL) throw new TypeError('Unsupported exchange protocol')
  const rawCapabilities = value.capabilities
  object(rawCapabilities)
  exact(rawCapabilities, capabilityKeys)
  const capabilities = Object.fromEntries(capabilityKeys.map(key => [key, parseCapability(rawCapabilities[key])])) as Record<CapabilityKey, Capability>
  return { exchangeProtocol: EXCHANGE_PROTOCOL, capabilities }
}

export function parseExchangeError(value: unknown): ExchangeError {
  object(value)
  exact(value, ['code', 'message', 'stage'])
  text(value.code, 80); text(value.message, 1000)
  if (!errorStages.includes(value.stage as typeof errorStages[number])) throw new TypeError('Invalid error stage')
  return { code: value.code, message: value.message, stage: value.stage as ExchangeError['stage'] }
}

export function parseDomainResult<T>(value: unknown, parseValue: (input: unknown) => T): DomainResult<T> {
  object(value)
  if (value.ok === true) {
    exact(value, ['ok', 'value'])
    return { ok: true, value: parseValue(value.value) }
  }
  exact(value, ['ok', 'error'])
  if (value.ok !== false) throw new TypeError('Invalid result')
  return { ok: false, error: parseExchangeError(value.error) }
}

export function parseExchangeView(value: unknown): ExchangeView {
  object(value)
  exact(value, ['exchangeId', 'version', 'status', 'operationStatus', 'lastSequence'])
  identity(value.exchangeId); positive(value.version)
  if (!['open', 'waiting_user', 'resuming', 'resolved', 'cancelled', 'unknown'].includes(value.status as string)) throw new TypeError('Invalid exchange status')
  if (!['waiting_context', 'waiting_user', 'resuming', 'running', 'completed', 'cancelled', 'unknown'].includes(value.operationStatus as string)) throw new TypeError('Invalid operation status')
  if (!Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0) throw new TypeError('Invalid sequence')
  return {
    exchangeId: value.exchangeId,
    version: value.version,
    status: value.status as ExchangeView['status'],
    operationStatus: value.operationStatus as ExchangeView['operationStatus'],
    lastSequence: value.lastSequence as number,
  }
}
