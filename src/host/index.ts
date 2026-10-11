import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { PLUGIN_REMOTE, PACKAGE_NAME } from '../shared/plugin-remote.js'
import {
  type DomainResult,
  type ExchangeCapabilities,
  type ExchangeAgentRead,
  type ExchangeError,
  type ExchangeRequest,
  type ExchangeScope,
  type ExchangeResolution,
  type ExchangeView,
  type NeedsContextReference,
  type RequestContextInput,
  type TranslationExchangeService,
  type ExecutorAdapter,
  type ExecutorOperationRef,
} from '../shared/contracts.js'
import { parseExchangeRequest, parseExchangeResolution, parseRequestContextInput } from '../shared/exchange-codec.js'
import { ExchangeStateStore, type ExchangeRecord } from './exchange-state.js'
import { MainAgentRoute } from './main-agent-route.js'

declare module '@deepseek-ai/cordis' {
  interface Context { translationExchange: TranslationExchangeService }
}

export const name = 'dsh-composer-extension'
export const inject = ['typert', 'sessionController'] as const

interface Registration { readonly adapter: ExecutorAdapter; disposers: number }
type StateFailure = 'not_found' | 'version_conflict' | 'invalid_state' | 'budget_exhausted' | 'idempotency_conflict' | 'scope_conflict'

const errorInfo: Record<StateFailure, Pick<ExchangeError, 'code' | 'message' | 'stage'>> = {
  not_found: { code: 'exchange_not_found', message: '未找到此主会话范围内的求助记录。', stage: 'authorize' },
  version_conflict: { code: 'exchange_version_conflict', message: '求助记录已变化，请重新查询后再操作。', stage: 'resolve' },
  invalid_state: { code: 'exchange_invalid_state', message: '当前求助状态不接受此操作。', stage: 'resolve' },
  budget_exhausted: { code: 'exchange_budget_exhausted', message: '此翻译操作的一次自动补充预算已用完。', stage: 'resolve' },
  idempotency_conflict: { code: 'exchange_idempotency_conflict', message: '同一操作身份不能更换问题或答复内容。', stage: 'protocol' },
  scope_conflict: { code: 'exchange_scope_conflict', message: '求助范围或宿主代次不匹配。', stage: 'authorize' },
}
const failure = <T>(info: Pick<ExchangeError, 'code' | 'message' | 'stage'>): DomainResult<T> => ({ ok: false, error: info })
const view = (record: ExchangeRecord): ExchangeView => ({ exchangeId: record.exchangeId, version: record.version, status: record.status,
  operationStatus: record.operationStatus, lastSequence: record.lastSequence })
const operationKey = (scope: Pick<ExchangeScope, 'mainSessionId' | 'translationSessionId' | 'operationId'>): string => JSON.stringify([scope.mainSessionId, scope.translationSessionId, scope.operationId])

/** Host-generation state is transient; source and answer bodies stay with T's Client history. */
export class TranslationExchangeHostService implements TranslationExchangeService {
  readonly typertRemote: { readonly service: TranslationExchangeHostService; readonly serviceKey: 'translationExchange'; readonly namespace: 'translationExchange' }
  readonly hostGeneration = crypto.randomUUID()
  private readonly store = new ExchangeStateStore()
  private readonly registrations = new Map<Context, Registration>()
  private readonly operationOwners = new Map<string, Registration>()
  private readonly mainAgents: MainAgentRoute
  private disposed = false

  constructor(readonly ctx: Context) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationExchange', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationExchange', namespace: 'translationExchange' })
    this.mainAgents = new MainAgentRoute({
      ctx,
      controller: ctx.sessionController,
      exchange: this,
      enqueueNotification: (agent, exchangeId, messageId) => {
        if (!this.mainAgents.owns(agent)) return false
        return typeof this.store.enqueueNotification(String(agent.id), exchangeId, messageId) !== 'string'
      },
      notificationClaimed: (agent, exchangeId, messageId, turn) => {
        if (this.mainAgents.owns(agent)) this.store.claimNotification(String(agent.id), exchangeId, messageId, turn)
      },
      notificationDiscarded: (agent, exchangeId, messageId) => {
        if (this.mainAgents.owns(agent)) this.store.discardNotification(String(agent.id), exchangeId, messageId)
      },
      userStopped: (agent, turn) => {
        if (this.mainAgents.owns(agent)) this.store.markUserStopped(String(agent.id), turn)
      },
      notificationCurrent: (agent, exchangeId, messageId) => {
        const record = this.store.get(String(agent.id), exchangeId)
        return this.mainAgents.owns(agent) && !!record && record.notificationMessageId === messageId &&
          ['enqueued', 'claimed', 'read'].includes(record.notification) && record.status === 'open' && !record.userStopped
      },
    })
  }

  register(owner: Context, adapter: ExecutorAdapter): () => void {
    if (this.disposed) throw new Error('exchange_service_disposed')
    const current = this.registrations.get(owner)
    if (current && current.adapter !== adapter) throw new Error('exchange_adapter_already_registered')
    const registration = current ?? { adapter, disposers: 0 }
    registration.disposers++
    this.registrations.set(owner, registration)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (--registration.disposers === 0 && this.registrations.get(owner) === registration) {
        this.registrations.delete(owner)
        for (const [key, value] of this.operationOwners) if (value === registration) this.operationOwners.delete(key)
      }
    }
  }

  async acceptNeedsContext(owner: Context, ref: NeedsContextReference, questions: RequestContextInput): Promise<DomainResult<ExchangeView>> {
    const registration = this.registrations.get(owner)
    if (this.disposed || !registration) return failure({ code: 'executor_unavailable', message: '翻译执行适配器未注册。', stage: 'authorize' })
    if (ref.hostGeneration !== this.hostGeneration || ref.scope.mainSessionId.length === 0) return failure(errorInfo.scope_conflict)
    let inspected: Record<string, unknown> | null
    try {
      inspected = await registration.adapter.inspectOperation({ ...ref.scope, callId: ref.callId, contextVersion: ref.contextVersion,
        hostGeneration: ref.hostGeneration, lastSequence: ref.lastSequence }) as Record<string, unknown> | null
    } catch {
      return failure({ code: 'operation_inspection_failed', message: '未能核对实际翻译控制事件。', stage: 'authorize' })
    }
    if (!inspected || inspected.callId !== ref.callId || inspected.contextVersion !== ref.contextVersion || inspected.hostGeneration !== this.hostGeneration ||
      inspected.lastSequence !== ref.lastSequence || inspected.status !== 'waiting_context' || JSON.stringify(inspected.scope) !== JSON.stringify(ref.scope)) return failure(errorInfo.scope_conflict)
    const sourceLength = inspected.sourceCodePointLength
    if (!Number.isSafeInteger(sourceLength) || (sourceLength as number) < 0) return failure({ code: 'invalid_operation_fact', message: '翻译执行事实缺少有效原文范围。', stage: 'protocol' })
    let parsed: RequestContextInput
    try { parsed = parseRequestContextInput(questions, sourceLength as number) }
    catch { return failure({ code: 'invalid_questions', message: '补充问题不符合范围或长度限制。', stage: 'protocol' }) }
    if (JSON.stringify(inspected.requestContext) !== JSON.stringify(parsed)) return failure({ code: 'invalid_operation_fact', message: '补充问题与实际模型控制事件不一致。', stage: 'protocol' })
    const result = this.store.register(ref.scope.mainSessionId, ref, parsed)
    if (typeof result === 'string') return failure(errorInfo[result])
    this.operationOwners.set(operationKey(ref.scope), registration)
    return { ok: true, value: view(result.record) }
  }

  async notifyMainAgent(owner: Context, ref: NeedsContextReference): Promise<boolean> {
    const registration = this.registrations.get(owner)
    if (!registration || this.disposed || ref.hostGeneration !== this.hostGeneration) return false
    const exact = [...this.operationOwners.entries()].find(([key, value]) => key === operationKey(ref.scope) && value === registration)
    if (!exact) return false
    const active = this.store.recordsForOperation(ref.scope.mainSessionId, ref.scope.operationId).find(item => item.callId === ref.callId && item.contextVersion === ref.contextVersion)
    if (!active || active.hostGeneration !== this.hostGeneration || active.status !== 'open') return false
    try {
      return await this.mainAgents.notify(ref.scope.mainSessionId, { translationSessionId: ref.scope.translationSessionId, operationId: ref.scope.operationId,
        exchangeId: active.exchangeId, expectedVersion: active.version })
    } catch { return false }
  }

  async finishOperation(owner: Context, ref: ExecutorOperationRef, result: 'completed' | 'needs_context' | 'unknown' | 'cancelled'): Promise<DomainResult<ExchangeView>> {
    const registration = this.registrations.get(owner)
    if (!registration || this.disposed || ref.hostGeneration !== this.hostGeneration) return failure(errorInfo.scope_conflict)
    const key = operationKey(ref), activeRegistration = this.operationOwners.get(key)
    if (activeRegistration !== registration) return failure(errorInfo.scope_conflict)
    const target = ref.exchangeId ? this.store.get(ref.mainSessionId, ref.exchangeId) : undefined
    if (target && (target.scope.translationSessionId !== ref.translationSessionId || target.scope.operationId !== ref.operationId || target.scope.unitId !== ref.unitId ||
      target.scope.topicId !== ref.topicId || target.scope.sourceVersion !== ref.sourceVersion)) return failure(errorInfo.scope_conflict)
    const finished = this.store.finishOperation(ref.mainSessionId, ref.operationId, ref.exchangeId ?? null, ref.lastSequence, result)
    if (typeof finished === 'string') return failure(errorInfo[finished])
    if (result === 'cancelled' && finished.notificationMessageId) await this.mainAgents.removeNotification(ref.mainSessionId, finished.exchangeId, finished.notificationMessageId)
    return { ok: true, value: view(finished) }
  }

  resumeStarted(owner: Context, ref: ExecutorOperationRef, resolutionId: string): void {
    const registration = this.registrations.get(owner)
    if (!registration || this.operationOwners.get(operationKey(ref)) !== registration || ref.hostGeneration !== this.hostGeneration || !ref.exchangeId) return
    this.store.resumeStarted(ref.mainSessionId, ref.exchangeId, resolutionId, ref.callId, ref.contextVersion)
  }

  async capabilities(): Promise<DomainResult<ExchangeCapabilities>> {
    const executorReady = !this.disposed && this.registrations.size > 0
    const capability = (state: 'available' | 'unavailable' | 'unknown', version: number | null, reason: string | null) => ({ state, version, reason })
    return { ok: true, value: { exchangeProtocol: 1, capabilities: {
      composer: capability('unknown', null, 'client_composer_capability_unreported'),
      materialBridge: capability('unknown', null, 'client_material_capability_unreported'),
      normal: executorReady ? capability('available', 2, null) : capability('unavailable', null, 'normal_executor_unavailable'),
      exchange: executorReady ? capability('available', 1, null) : capability('unavailable', null, 'executor_adapter_unavailable'),
      modelControl: this.mainAgents.available ? capability('available', 1, null) : capability('unavailable', null, 'main_agent_route_unavailable'),
    } } }
  }

  async query(request: ExchangeRequest): Promise<DomainResult<ExchangeView>> {
    const registration = this.authorized(request)
    if (!registration) return failure(errorInfo.scope_conflict)
    const record = this.store.query(request.mainSessionId, request)
    return typeof record === 'string' ? failure(errorInfo[record]) : { ok: true, value: view(record) }
  }

  async cancel(request: ExchangeRequest): Promise<DomainResult<ExchangeView>> {
    const registration = this.authorized(request)
    if (!registration) return failure(errorInfo.scope_conflict)
    const record = this.store.query(request.mainSessionId, request)
    if (typeof record === 'string') return failure(errorInfo[record])
    const cancelled = this.store.cancel(request.mainSessionId, request)
    if (typeof cancelled === 'string') return failure(errorInfo[cancelled])
    if (cancelled.notificationMessageId) await this.mainAgents.removeNotification(request.mainSessionId, cancelled.exchangeId, cancelled.notificationMessageId)
    try {
      if (await registration.adapter.cancelOperation(this.operationRef(cancelled)) !== true) {
        this.store.markUnknown(request.mainSessionId, cancelled.exchangeId)
        return failure({ code: 'cancel_unconfirmed', message: '取消请求已登记，但执行端尚未确认；查询状态为 unknown，未自动重发。', stage: 'writeback' })
      }
      return { ok: true, value: view(cancelled) }
    } catch {
      this.store.markUnknown(request.mainSessionId, cancelled.exchangeId)
      return failure({ code: 'cancel_unconfirmed', message: '取消请求已登记，但执行端尚未确认；请查询原操作。', stage: 'writeback' })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.mainAgents.dispose(); this.registrations.clear(); this.operationOwners.clear()
  }

  readForAgent(agent: Agent, request: Omit<ExchangeRequest, 'mainSessionId'>): DomainResult<ExchangeAgentRead> {
    if (this.disposed || !this.mainAgents.owns(agent)) return failure(errorInfo.scope_conflict)
    const mainSessionId = String(agent.id)
    let fullRequest: ExchangeRequest
    try { fullRequest = parseExchangeRequest({ mainSessionId, ...request }) } catch { return failure({ code: 'invalid_exchange_request', message: '求助身份或版本格式无效。', stage: 'protocol' }) }
    const registration = this.operationOwners.get(operationKey(fullRequest))
    if (!registration) return failure(errorInfo.scope_conflict)
    const found = this.store.query(mainSessionId, fullRequest)
    if (typeof found === 'string') return failure(errorInfo[found])
    const record = found.notification === 'claimed' && !found.userStopped
      ? this.store.readNotification(mainSessionId, found.exchangeId) : found
    if (typeof record === 'string') return failure(errorInfo[record])
    return { ok: true, value: { ...view(record), scope: record.scope, callId: record.callId, contextVersion: record.contextVersion,
      questions: structuredClone(record.questions), notification: record.notification, notificationMessageId: record.notificationMessageId,
      notificationTurn: record.notificationTurn, userStopped: record.userStopped } }
  }

  statusForAgent(agent: Agent, request: Omit<ExchangeRequest, 'mainSessionId'>): DomainResult<ExchangeView> {
    if (this.disposed || !this.mainAgents.owns(agent)) return failure(errorInfo.scope_conflict)
    let fullRequest: ExchangeRequest
    try { fullRequest = parseExchangeRequest({ mainSessionId: String(agent.id), ...request }) } catch { return failure({ code: 'invalid_exchange_request', message: '求助身份或版本格式无效。', stage: 'protocol' }) }
    if (!this.operationOwners.has(operationKey(fullRequest))) return failure(errorInfo.scope_conflict)
    const record = this.store.query(fullRequest.mainSessionId, fullRequest)
    return typeof record === 'string' ? failure(errorInfo[record]) : { ok: true, value: view(record) }
  }

  async resolveForAgent(agent: Agent, request: Omit<ExchangeRequest, 'mainSessionId'>, resolutionId: string,
    resolution: ExchangeResolution): Promise<DomainResult<ExchangeView>> {
    if (this.disposed || !this.mainAgents.owns(agent)) return failure(errorInfo.scope_conflict)
    let fullRequest: ExchangeRequest, parsed: ExchangeResolution
    try {
      fullRequest = parseExchangeRequest({ mainSessionId: String(agent.id), ...request })
      parsed = parseExchangeResolution(resolution)
      if (typeof resolutionId !== 'string' || !resolutionId.trim() || resolutionId.length > 512) throw new TypeError('Invalid resolution identity')
    } catch { return failure({ code: 'invalid_exchange_resolution', message: '答复内容、身份或版本超出允许范围。', stage: 'protocol' }) }
    resolution = parsed
    const registration = this.operationOwners.get(operationKey(fullRequest))
    if (!registration) return failure(errorInfo.scope_conflict)
    const existing = this.store.query(fullRequest.mainSessionId, fullRequest)
    if (typeof existing === 'string') return failure(errorInfo[existing])
    const replay = this.store.resolutionReplay(fullRequest.mainSessionId, fullRequest, resolutionId, resolution)
    if (replay !== undefined) return typeof replay === 'string' ? failure(errorInfo[replay]) : { ok: true, value: view(replay) }
    if (existing.version !== fullRequest.expectedVersion) return failure(errorInfo.version_conflict)
    if (!['open', 'waiting_user'].includes(existing.status)) return failure(errorInfo.invalid_state)
    if (resolution.kind === 'answer' && existing.budgetUsed > 0) return failure(errorInfo.budget_exhausted)
    const adapter = registration.adapter
    const ref = this.operationRef(existing)
    let phase: 'prepare' | 'register' | 'dispatch' = 'prepare'
    try {
      const prepared = await adapter.prepareResume(ref, resolutionId, fullRequest.expectedVersion, resolution)
      // Preparation is side-effect free. CAS is checked again after it, before Client registration.
      const resolved = this.store.resolve(fullRequest.mainSessionId, fullRequest, resolutionId, resolution)
      if (typeof resolved === 'string') return failure(errorInfo[resolved])
      phase = 'register'
      const registered = await adapter.registerResume(prepared)
      if (registered.candidateCallId !== prepared.candidateCallId || registered.contextVersion !== prepared.contextVersion || !Number.isSafeInteger(registered.lastSequence) ||
        registered.lastSequence < ref.lastSequence || prepared.contextVersion !== ref.contextVersion + Number(resolution.kind === 'answer')) {
        this.store.markUnknown(fullRequest.mainSessionId, resolved.exchangeId)
        return failure({ code: 'resume_registration_unknown', message: '续作登记回执身份不一致；状态未知，未派发新调用。', stage: 'writeback' })
      }
      const confirmed = this.store.acknowledgeSequence(fullRequest.mainSessionId, resolved.exchangeId, registered.lastSequence)
      if (typeof confirmed === 'string') return failure(errorInfo[confirmed])
      if (resolution.kind === 'defer') return { ok: true, value: view(confirmed) }
      if (resolution.kind === 'abort') {
        if (await adapter.cancelOperation(ref) !== true) throw Object.assign(new Error('cancel_unconfirmed'), { code: 'cancel_unconfirmed' })
        if (resolved.notificationMessageId) await this.mainAgents.removeNotification(fullRequest.mainSessionId, resolved.exchangeId, resolved.notificationMessageId)
        return { ok: true, value: view(resolved) }
      }
      if (!prepared.candidateCallId || !registered.candidateCallId) return failure({ code: 'resume_candidate_missing', message: '续作准备回执缺少候选调用身份。', stage: 'prepare' })
      const intent = this.store.registerResume(fullRequest.mainSessionId, resolved.exchangeId, resolutionId, registered.candidateCallId, registered.contextVersion)
      if (typeof intent === 'string') return failure(errorInfo[intent])
      const claimed = this.store.claimDispatch(fullRequest.mainSessionId, resolved.exchangeId, resolutionId)
      if (typeof claimed === 'string') return failure(errorInfo[claimed])
      phase = 'dispatch'
      const dispatched = await adapter.dispatchResume(prepared)
      if (dispatched.status !== 'resuming') throw Object.assign(new Error('dispatch_unconfirmed'), { code: 'dispatch_unconfirmed' })
      return { ok: true, value: view(claimed) }
    } catch (error) {
      if (phase !== 'prepare') this.store.markUnknown(fullRequest.mainSessionId, existing.exchangeId)
      return failure({ code: (error as { code?: string }).code ?? 'resume_failed', message: '补充操作未取得确认；请查询原 exchange，模型不会自动重发。', stage: phase === 'prepare' ? 'prepare' : phase === 'register' ? 'register_resume' : 'dispatch' })
    }
  }

  private authorized(request: ExchangeRequest): Registration | undefined {
    if (this.disposed) return undefined
    const registration = this.operationOwners.get(JSON.stringify([request.mainSessionId, request.translationSessionId, request.operationId]))
    const peerId = this.ctx.invocation?.peer.id
    return registration && peerId && registration.adapter.authorizePeer?.(request.mainSessionId, peerId) ? registration : undefined
  }

  private operationRef(record: ExchangeRecord): ExecutorOperationRef {
    return { ...record.scope, callId: record.resumeIntent?.candidateCallId ?? record.callId,
      contextVersion: record.resumeIntent?.contextVersion ?? record.contextVersion, hostGeneration: record.hostGeneration, lastSequence: record.lastSequence,
      exchangeId: record.exchangeId }
  }
}

export function apply(ctx: Context): void {
  const exchange = new TranslationExchangeHostService(ctx)
  ctx.provide('translationExchange', exchange)

  const contribution: TypertContribution = {
    package: PACKAGE_NAME,
    face: 'host',
    schemas: [],
    invocations: PLUGIN_REMOTE.descriptors,
    model: { services: [], events: [], objects: [] },
  }
  const unregister = ctx.typert.register(contribution)
  ctx.effect(() => () => { unregister(); exchange.dispose() }, `${PACKAGE_NAME}.remote`)
}
