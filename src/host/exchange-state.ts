import type { ExchangeResolution, ExchangeRequest, ExchangeScope, ExchangeView, RequestContextInput } from '../shared/contracts.js'

import type { NeedsContextReference } from '../shared/contracts.js'

export interface ExchangeRecord extends ExchangeView {
  readonly scope: ExchangeScope
  readonly callId: string
  readonly contextVersion: number
  readonly hostGeneration: string
  readonly questions: RequestContextInput
  readonly notification: 'not_enqueued' | 'enqueued' | 'claimed' | 'read' | 'discarded'
  readonly notificationMessageId: string | null
  readonly notificationTurn: number | null
  readonly userStopped: boolean
  readonly resolutionId: string | null
  readonly resolution: ExchangeResolution | null
  readonly budgetUsed: number
  readonly resumeIntent: { readonly resolutionId: string; readonly candidateCallId: string; readonly contextVersion: number } | null
  readonly dispatchToken: string | null
}

export type ExchangeStateError = 'not_found' | 'version_conflict' | 'invalid_state' | 'budget_exhausted' | 'idempotency_conflict' | 'scope_conflict'

export class ExchangeStateStore {
  private readonly records = new Map<string, ExchangeRecord>()
  private readonly byCall = new Map<string, string>()
  private readonly operationBudgets = new Map<string, number>()
  private readonly generations = new Map<string, string>()
  private readonly operationScopes = new Map<string, ExchangeScope>()
  private readonly resolutions = new Map<string, string>()

  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  register(ownerId: string, ref: NeedsContextReference, questions: RequestContextInput): { readonly record: ExchangeRecord; readonly notify: boolean } | ExchangeStateError {
    const { scope } = ref
    if (scope.mainSessionId !== ownerId || !Number.isSafeInteger(ref.contextVersion) || ref.contextVersion < 1 ||
      !Number.isSafeInteger(ref.lastSequence) || ref.lastSequence < 1) return 'scope_conflict'
    const operationKey = JSON.stringify([ownerId, scope.translationSessionId, scope.operationId])
    const knownGeneration = this.generations.get(operationKey)
    if (knownGeneration && knownGeneration !== ref.hostGeneration) return 'scope_conflict'
    const knownScope = this.operationScopes.get(operationKey)
    if (knownScope && JSON.stringify(knownScope) !== JSON.stringify(scope)) return 'scope_conflict'
    if ([...this.records.values()].some(record => record.scope.mainSessionId === ownerId && record.scope.translationSessionId === scope.translationSessionId &&
      record.scope.operationId !== scope.operationId && ['open', 'waiting_user', 'resuming', 'unknown'].includes(record.status))) return 'invalid_state'
    const callKey = JSON.stringify([ownerId, scope.translationSessionId, scope.operationId, ref.callId]), previousId = this.byCall.get(callKey)
    if (previousId) {
      const previous = this.records.get(previousId)!
      if (JSON.stringify(previous.scope) !== JSON.stringify(scope) || previous.hostGeneration !== ref.hostGeneration || previous.contextVersion !== ref.contextVersion || JSON.stringify(previous.questions) !== JSON.stringify(questions)) return 'idempotency_conflict'
      return { record: structuredClone(previous), notify: false }
    }
    const budgetKey = JSON.stringify([ownerId, scope.translationSessionId, scope.operationId]), budgetUsed = this.operationBudgets.get(budgetKey) ?? 0
    const status = budgetUsed === 0 ? 'open' : 'waiting_user'
    const record: ExchangeRecord = { exchangeId: this.createId(), version: 1, status, operationStatus: status === 'open' ? 'waiting_context' : 'waiting_user', lastSequence: ref.lastSequence,
      scope: structuredClone(scope), callId: ref.callId, contextVersion: ref.contextVersion, hostGeneration: ref.hostGeneration,
      questions: structuredClone(questions), notification: 'not_enqueued', notificationMessageId: null, notificationTurn: null, userStopped: false,
      resolutionId: null, resolution: null, budgetUsed, resumeIntent: null, dispatchToken: null }
    this.records.set(record.exchangeId, record); this.byCall.set(callKey, record.exchangeId)
    this.generations.set(operationKey, ref.hostGeneration)
    this.operationScopes.set(operationKey, structuredClone(scope))
    return { record: structuredClone(record), notify: status === 'open' }
  }

  enqueueNotification(ownerId: string, exchangeId: string, messageId: string): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId) return 'not_found'
    if (record.notification === 'enqueued' && record.notificationMessageId === messageId) return structuredClone(record)
    if (record.notification !== 'not_enqueued' || record.status !== 'open' || record.userStopped) return 'invalid_state'
    const updated = { ...record, notification: 'enqueued' as const, notificationMessageId: messageId }
    this.records.set(exchangeId, updated)
    return structuredClone(updated)
  }

  claimNotification(ownerId: string, exchangeId: string, messageId: string, turn: number): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId || record.notificationMessageId !== messageId) return 'not_found'
    if (record.notification === 'claimed' && record.notificationTurn === turn) return structuredClone(record)
    if (record.notification !== 'enqueued' || record.status !== 'open') return 'invalid_state'
    const updated = { ...record, notification: 'claimed' as const, notificationTurn: turn }
    this.records.set(exchangeId, updated)
    return structuredClone(updated)
  }

  readNotification(ownerId: string, exchangeId: string): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId) return 'not_found'
    if (record.notification === 'read') return structuredClone(record)
    if (record.notification !== 'claimed' || record.userStopped) return 'invalid_state'
    const updated = { ...record, notification: 'read' as const }
    this.records.set(exchangeId, updated)
    return structuredClone(updated)
  }

  discardNotification(ownerId: string, exchangeId: string, messageId: string): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId || record.notificationMessageId !== messageId) return 'not_found'
    if (record.notification === 'discarded') return structuredClone(record)
    if (!['enqueued', 'claimed'].includes(record.notification)) return 'invalid_state'
    const updated = { ...record, notification: 'discarded' as const }
    this.records.set(exchangeId, updated)
    return structuredClone(updated)
  }

  markUserStopped(ownerId: string, turn: number): void {
    for (const [exchangeId, record] of this.records) {
      if (record.scope.mainSessionId === ownerId && (record.notificationTurn === turn || ['open', 'waiting_user', 'resuming'].includes(record.status)) && !record.userStopped) {
        this.records.set(exchangeId, { ...record, userStopped: true })
      }
    }
  }

  get(ownerId: string, exchangeId: string): ExchangeRecord | undefined {
    const record = this.records.get(exchangeId)
    return record?.scope.mainSessionId === ownerId ? structuredClone(record) : undefined
  }

  recordsForOperation(ownerId: string, operationId: string): readonly ExchangeRecord[] {
    return [...this.records.values()].filter(record => record.scope.mainSessionId === ownerId && record.scope.operationId === operationId).map(record => structuredClone(record))
  }

  query(ownerId: string, request: ExchangeRequest): ExchangeRecord | ExchangeStateError {
    const record = this.match(ownerId, request)
    return record ? structuredClone(record) : 'not_found'
  }
  resolutionReplay(ownerId: string, request: ExchangeRequest, resolutionId: string, resolution: ExchangeResolution): ExchangeRecord | ExchangeStateError | undefined {
    const record = this.match(ownerId, request)
    if (!record) return 'not_found'
    const known = this.resolutions.get(JSON.stringify([record.exchangeId, resolutionId]))
    return known === undefined ? undefined : known === JSON.stringify(resolution) ? structuredClone(record) : 'idempotency_conflict'
  }

  resolve(ownerId: string, request: ExchangeRequest, resolutionId: string, resolution: ExchangeResolution): ExchangeRecord | ExchangeStateError {
    const record = this.match(ownerId, request)
    if (!record) return 'not_found'
    const replay = this.resolutionReplay(ownerId, request, resolutionId, resolution)
    if (replay !== undefined) return replay
    if (record.version !== request.expectedVersion) return 'version_conflict'
    if (!['open', 'waiting_user'].includes(record.status)) return 'invalid_state'
    const budgetKey = JSON.stringify([ownerId, record.scope.translationSessionId, record.scope.operationId]), budgetUsed = this.operationBudgets.get(budgetKey) ?? 0
    if (resolution.kind === 'answer' && budgetUsed > 0) return 'budget_exhausted'
    const nextStatus = resolution.kind === 'answer' ? 'resuming' : resolution.kind === 'defer' ? 'waiting_user' : 'cancelled'
    const next: ExchangeRecord = { ...record, version: record.version + 1, status: nextStatus,
      operationStatus: resolution.kind === 'answer' ? 'resuming' : resolution.kind === 'defer' ? 'waiting_user' : 'cancelled',
      resolutionId, resolution: structuredClone(resolution), budgetUsed: budgetUsed + (resolution.kind === 'answer' ? 1 : 0), resumeIntent: null, dispatchToken: null }
    this.records.set(record.exchangeId, next)
    this.resolutions.set(JSON.stringify([record.exchangeId, resolutionId]), JSON.stringify(resolution))
    this.operationBudgets.set(budgetKey, next.budgetUsed)
    return structuredClone(next)
  }

  registerResume(ownerId: string, exchangeId: string, resolutionId: string, candidateCallId: string, contextVersion: number): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId) return 'not_found'
    if (record.resumeIntent?.resolutionId === resolutionId) return record.resumeIntent.candidateCallId === candidateCallId && record.resumeIntent.contextVersion === contextVersion
      ? structuredClone(record) : 'idempotency_conflict'
    if (record.resumeIntent) return 'invalid_state'
    if (record.status !== 'resuming' || record.resolutionId !== resolutionId || record.resolution?.kind !== 'answer' || contextVersion !== record.contextVersion + 1) return 'invalid_state'
    const next = { ...record, version: record.version + 1, resumeIntent: { resolutionId, candidateCallId, contextVersion } }
    this.records.set(exchangeId, next)
    return structuredClone(next)
  }

  claimDispatch(ownerId: string, exchangeId: string, resolutionId: string): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId) return 'not_found'
    if (record.dispatchToken) return record.resolutionId === resolutionId ? structuredClone(record) : 'idempotency_conflict'
    if (record.status !== 'resuming' || record.resolutionId !== resolutionId || record.resumeIntent?.resolutionId !== resolutionId) return 'invalid_state'
    const next = { ...record, dispatchToken: this.createId() }
    this.records.set(exchangeId, next)
    return structuredClone(next)
  }
  acknowledgeSequence(ownerId: string, exchangeId: string, lastSequence: number): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId) return 'not_found'
    if (!Number.isSafeInteger(lastSequence) || lastSequence < record.lastSequence) return 'invalid_state'
    const next = { ...record, lastSequence }
    this.records.set(exchangeId, next)
    return structuredClone(next)
  }

  finish(ownerId: string, exchangeId: string, result: 'completed' | 'needs_context' | 'unknown' | 'cancelled', lastSequence?: number): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId) return 'not_found'
    if (['resolved', 'cancelled', 'unknown'].includes(record.status)) return structuredClone(record)
    if (result === 'needs_context' && record.budgetUsed > 0) {
      const changed = record.status !== 'waiting_user' || record.operationStatus !== 'waiting_user'
      const next = { ...record, version: record.version + Number(changed), ...(lastSequence === undefined ? {} : { lastSequence }),
        status: 'waiting_user' as const, operationStatus: 'waiting_user' as const, resumeIntent: null, dispatchToken: null }
      this.records.set(exchangeId, next); return structuredClone(next)
    }
    if (result === 'needs_context') {
      const changed = record.status !== 'open' || record.operationStatus !== 'waiting_context'
      const next = { ...record, version: record.version + Number(changed), ...(lastSequence === undefined ? {} : { lastSequence }),
        status: 'open' as const, operationStatus: 'waiting_context' as const, resumeIntent: null, dispatchToken: null }
      this.records.set(exchangeId, next); return structuredClone(next)
    }
    const status: ExchangeRecord['status'] = result === 'completed' ? 'resolved' : result === 'cancelled' ? 'cancelled' : 'unknown'
    const operationStatus: ExchangeRecord['operationStatus'] = result === 'completed' ? 'completed' : result === 'cancelled' ? 'cancelled' : 'unknown'
    const changed = record.status !== status || record.operationStatus !== operationStatus
    const next = { ...record, version: record.version + Number(changed), ...(lastSequence === undefined ? {} : { lastSequence }), status, operationStatus, resumeIntent: null, dispatchToken: null }
    this.records.set(exchangeId, next); return structuredClone(next)
  }

  finishOperation(ownerId: string, operationId: string, currentExchangeId: string | null, lastSequence: number,
    result: 'completed' | 'needs_context' | 'unknown' | 'cancelled'): ExchangeRecord | ExchangeStateError {
    const records = [...this.records.values()].filter(record => record.scope.mainSessionId === ownerId && record.scope.operationId === operationId)
    if (!records.length) return 'not_found'
    const current = currentExchangeId ? this.records.get(currentExchangeId) : records.at(-1)
    if (!current || current.scope.mainSessionId !== ownerId || current.scope.operationId !== operationId) return 'not_found'
    for (const record of records) {
      if (record.exchangeId !== currentExchangeId && record.status === 'resuming') this.finish(ownerId, record.exchangeId, 'completed')
    }
    return this.finish(ownerId, current.exchangeId, result, lastSequence)
  }

  cancel(ownerId: string, request: ExchangeRequest): ExchangeRecord | ExchangeStateError {
    const record = this.match(ownerId, request)
    if (!record) return 'not_found'
    if (record.version !== request.expectedVersion) return 'version_conflict'
    if (record.status === 'cancelled') return structuredClone(record)
    if (record.status === 'resolved' || record.status === 'unknown') return 'invalid_state'
    const next = { ...record, version: record.version + 1, status: 'cancelled' as const, operationStatus: 'cancelled' as const, resumeIntent: null, dispatchToken: null }
    this.records.set(record.exchangeId, next); return structuredClone(next)
  }

  markUnknown(ownerId: string, exchangeId: string): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId) return 'not_found'
    if (record.status === 'resolved' || record.status === 'unknown') return structuredClone(record)
    const next = { ...record, version: record.version + 1, status: 'unknown' as const, operationStatus: 'unknown' as const,
      resumeIntent: null, dispatchToken: null }
    this.records.set(exchangeId, next); return structuredClone(next)
  }

  resumeStarted(ownerId: string, exchangeId: string, resolutionId: string, callId: string, contextVersion: number): ExchangeRecord | ExchangeStateError {
    const record = this.records.get(exchangeId)
    if (!record || record.scope.mainSessionId !== ownerId) return 'not_found'
    if (record.resumeIntent?.resolutionId !== resolutionId || record.resumeIntent.candidateCallId !== callId || record.resumeIntent.contextVersion !== contextVersion ||
      !record.dispatchToken || record.status !== 'resuming') return 'invalid_state'
    if (record.operationStatus === 'running') return structuredClone(record)
    const next = { ...record, version: record.version + 1, operationStatus: 'running' as const }
    this.records.set(exchangeId, next)
    return structuredClone(next)
  }

  private match(ownerId: string, request: ExchangeRequest): ExchangeRecord | undefined {
    const record = this.records.get(request.exchangeId)
    return record && record.scope.mainSessionId === ownerId && record.scope.translationSessionId === request.translationSessionId && record.scope.operationId === request.operationId
      ? record : undefined
  }
}
