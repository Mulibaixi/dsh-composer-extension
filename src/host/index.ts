import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { PLUGIN_REMOTE, HOST_PATCH_REMOTE, PACKAGE_NAME } from '../shared/plugin-remote.js'
import { createHostPatchService } from './host-patch.js'
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
  TASK_PHASE_PROTOCOL,
  type TaskPhaseCapability,
  type TaskPhaseEvent,
  type TaskPhaseInspector,
  type TaskPhaseView,
  BATCH_PROTOCOL,
  type BatchExchangeCapabilities,
  type BatchTaskPhaseEvent,
  type BatchTaskPhaseInspector,
} from '../shared/contracts.js'
import { parseExchangeRequest, parseExchangeResolution, parseRequestContextInput } from '../shared/exchange-codec.js'
import { ExchangeStateStore, type ExchangeRecord } from './exchange-state.js'
import { MainAgentRoute } from './main-agent-route.js'
import { parseBatchTaskPhaseEvent, parseTaskPhaseEvent } from './task-phase.js'

declare module '@deepseek-ai/cordis' {
  interface Context { translationExchange: TranslationExchangeService }
}

export const name = 'dsh-composer-extension'
export const inject = ['typert', 'sessionController'] as const

interface Registration { readonly adapter: ExecutorAdapter; disposers: number }
type PhaseRegistration = { readonly kind: 'analysis'; readonly inspector: TaskPhaseInspector; disposers: number }
  | { readonly kind: 'batch'; readonly inspector: BatchTaskPhaseInspector; disposers: number }
interface PhaseRecord {
  readonly registration: PhaseRegistration
  readonly event: TaskPhaseEvent | BatchTaskPhaseEvent
  readonly signature: string
  state: TaskPhaseView['state']
  messageId: string | null
  userStopped: boolean
  pending?: Promise<DomainResult<TaskPhaseView>>
}
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
  private readonly batchRegistrations = new Map<Context, Registration>()
  private readonly operationOwners = new Map<string, Registration>()
  private readonly phaseRegistrations = new Map<Context, PhaseRegistration>()
  private readonly batchPhaseRegistrations = new Map<Context, PhaseRegistration>()
  private readonly phaseRecords = new Map<string, PhaseRecord>()
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
        if (this.mainAgents.owns(agent)) for (const record of this.phaseRecords.values()) {
          if (record.event.scope.mainSessionId === String(agent.id)) record.userStopped = true
        }
      },
      notificationCurrent: (agent, exchangeId, messageId) => {
        const record = this.store.get(String(agent.id), exchangeId)
        return this.mainAgents.owns(agent) && !!record && record.notificationMessageId === messageId &&
          this.operationOwners.has(operationKey(record.scope)) &&
          ['enqueued', 'claimed', 'read'].includes(record.notification) && record.status === 'open' && !record.userStopped
      },
      taskPhase: {
        read: (agent, eventId) => this.inspectPhaseForAgent(agent, eventId, 'not_enqueued'),
        enqueued: (agent, eventId, messageId) => {
          const record = this.phaseForAgent(agent, eventId)
          if (!record || record.state !== 'not_enqueued' || record.userStopped) return false
          record.state = 'enqueued'; record.messageId = messageId
          return true
        },
        claimed: (agent, eventId, messageId) => {
          const record = this.phaseForAgent(agent, eventId)
          if (record?.messageId === messageId && record.state === 'enqueued') record.state = 'claimed'
        },
        discarded: (agent, eventId, messageId) => {
          const record = this.phaseForAgent(agent, eventId)
          if (record?.messageId === messageId) record.state = 'discarded'
        },
        current: async (agent, eventId, messageId) => {
          const record = this.phaseForAgent(agent, eventId)
          if (!record || record.messageId !== messageId || !['enqueued', 'claimed'].includes(record.state)) return false
          return !!await this.inspectPhaseForAgent(agent, eventId, record.state)
        },
      },
    })
  }

  registerTaskPhaseInspector(owner: Context, inspector: TaskPhaseInspector): () => void {
    return this.registerPhase(owner, { kind: 'analysis', inspector, disposers: 0 }, this.phaseRegistrations)
  }

  registerBatchTaskPhaseInspector(owner: Context, inspector: BatchTaskPhaseInspector): () => void {
    return this.registerPhase(owner, { kind: 'batch', inspector, disposers: 0 }, this.batchPhaseRegistrations)
  }

  private registerPhase(owner: Context, candidate: PhaseRegistration, registrations: Map<Context, PhaseRegistration>): () => void {
    if (this.disposed) throw new Error('exchange_service_disposed')
    const current = registrations.get(owner)
    if (current && current.inspector !== candidate.inspector) throw new Error('task_phase_inspector_already_registered')
    const registration = current ?? candidate
    registration.disposers++
    registrations.set(owner, registration)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (--registration.disposers !== 0 || registrations.get(owner) !== registration) return
      registrations.delete(owner)
      for (const [key, record] of this.phaseRecords) if (record.registration === registration) {
        this.phaseRecords.delete(key)
        if (record.messageId) this.mainAgents.removeTaskPhaseNotification(record.event.scope.mainSessionId, record.event.eventId, record.messageId)
      }
    }
  }

  taskPhaseCapabilities(): TaskPhaseCapability {
    const ready = !this.disposed && this.mainAgents.available
    return { phaseProtocol: TASK_PHASE_PROTOCOL, ready, reason: ready ? null : 'main_agent_route_unavailable' }
  }

  async notifyTaskPhase(owner: Context, input: TaskPhaseEvent): Promise<DomainResult<TaskPhaseView>> {
    return this.notifyPhase(this.phaseRegistrations.get(owner), input)
  }

  async notifyBatchTaskPhase(owner: Context, input: BatchTaskPhaseEvent): Promise<DomainResult<TaskPhaseView>> {
    return this.notifyPhase(this.batchPhaseRegistrations.get(owner), input)
  }

  private async notifyPhase(registration: PhaseRegistration | undefined, input: TaskPhaseEvent | BatchTaskPhaseEvent): Promise<DomainResult<TaskPhaseView>> {
    if (this.disposed || !registration) return failure({ code: 'task_phase_inspector_unavailable', message: '阶段事实核验端未注册。', stage: 'authorize' })
    let event: TaskPhaseEvent | BatchTaskPhaseEvent
    try { event = registration.kind === 'analysis' ? parseTaskPhaseEvent(input) : parseBatchTaskPhaseEvent(input) }
    catch { return failure({ code: 'invalid_task_phase', message: '阶段通知必须使用明确身份、实际状态和短结果引用。', stage: 'protocol' }) }
    if (event.hostGeneration !== this.hostGeneration) return failure(errorInfo.scope_conflict)
    const key = JSON.stringify([event.scope.mainSessionId, event.eventId]), signature = JSON.stringify(event)
    let record = this.phaseRecords.get(key)
    if (record && (record.registration !== registration || record.signature !== signature)) return failure(errorInfo.idempotency_conflict)
    if (record?.pending) return record.pending
    if (record) return { ok: true, value: { eventId: event.eventId, state: record.state } }
    if (this.phaseRecords.size >= 1024) return failure({ code: 'task_phase_budget_exhausted', message: '当前宿主阶段通知记录已达上限。', stage: 'notify' })
    record = { registration, event, signature, state: 'not_enqueued', messageId: null, userStopped: false }
    this.phaseRecords.set(key, record)
    const fixed = record
    fixed.pending = (async (): Promise<DomainResult<TaskPhaseView>> => {
      if (!await this.phaseFactCurrent(fixed)) {
        fixed.state = 'unavailable'
        return failure({ code: 'task_phase_fact_mismatch', message: '阶段通知与已授权的实际状态不一致。', stage: 'authorize' })
      }
      try {
        if (!await this.mainAgents.notifyTaskPhase(event) && fixed.state === 'not_enqueued') fixed.state = 'unavailable'
      } catch { if (fixed.state === 'not_enqueued') fixed.state = 'unavailable' }
      return { ok: true, value: { eventId: event.eventId, state: fixed.state } }
    })()
    try { return await fixed.pending } finally { delete fixed.pending }
  }

  private phaseForAgent(agent: Agent, eventId: string): PhaseRecord | undefined {
    const record = this.phaseRecords.get(JSON.stringify([String(agent.id), eventId]))
    return !this.disposed && this.mainAgents.owns(agent) && record && this.phaseRegistered(record.registration) &&
      record.event.scope.mainSessionId === String(agent.session.id) ? record : undefined
  }

  private async phaseFactCurrent(record: PhaseRecord): Promise<boolean> {
    if (this.disposed || !this.phaseRegistered(record.registration) || record.userStopped) return false
    try {
      const fact = record.registration.kind === 'analysis'
        ? await record.registration.inspector.inspectTaskPhase(structuredClone(record.event) as TaskPhaseEvent)
        : await record.registration.inspector.inspectBatchTaskPhase(structuredClone(record.event) as BatchTaskPhaseEvent)
      return !this.disposed && this.phaseRegistered(record.registration) && !record.userStopped && fact !== null &&
        JSON.stringify(record.registration.kind === 'analysis' ? parseTaskPhaseEvent(fact) : parseBatchTaskPhaseEvent(fact)) === record.signature
    } catch { return false }
  }

  private phaseRegistered(registration: PhaseRegistration): boolean {
    return [...(registration.kind === 'analysis' ? this.phaseRegistrations : this.batchPhaseRegistrations).values()].includes(registration)
  }

  private async inspectPhaseForAgent(agent: Agent, eventId: string, state: TaskPhaseView['state']): Promise<TaskPhaseEvent | BatchTaskPhaseEvent | null> {
    const record = this.phaseForAgent(agent, eventId)
    if (!record || record.state !== state || !await this.phaseFactCurrent(record)) return null
    return this.phaseForAgent(agent, eventId) === record && record.state === state && !record.userStopped ? structuredClone(record.event) : null
  }

  register(owner: Context, adapter: ExecutorAdapter): () => void {
    return this.registerExecutor(owner, adapter, this.registrations)
  }

  registerBatch(owner: Context, adapter: ExecutorAdapter): () => void {
    return this.registerExecutor(owner, adapter, this.batchRegistrations)
  }

  private registerExecutor(owner: Context, adapter: ExecutorAdapter, registrations: Map<Context, Registration>): () => void {
    if (this.disposed) throw new Error('exchange_service_disposed')
    const current = registrations.get(owner)
    if (current && current.adapter !== adapter) throw new Error('exchange_adapter_already_registered')
    const registration = current ?? { adapter, disposers: 0 }
    registration.disposers++
    registrations.set(owner, registration)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (--registration.disposers === 0 && registrations.get(owner) === registration) {
        registrations.delete(owner)
        for (const [key, value] of this.operationOwners) if (value === registration) {
          this.operationOwners.delete(key)
          const [mainSessionId, translationSessionId, operationId] = JSON.parse(key) as string[]
          for (const record of this.store.recordsForOperation(mainSessionId!, operationId!)) {
            if (record.scope.translationSessionId === translationSessionId && record.notificationMessageId)
              void this.mainAgents.removeNotification(mainSessionId!, record.exchangeId, record.notificationMessageId).catch(() => {})
          }
        }
      }
    }
  }

  async acceptNeedsContext(owner: Context, ref: NeedsContextReference, questions: RequestContextInput): Promise<DomainResult<ExchangeView>> {
    return this.acceptContext(this.registrations.get(owner), ref, questions)
  }

  async acceptBatchNeedsContext(owner: Context, ref: NeedsContextReference, questions: RequestContextInput): Promise<DomainResult<ExchangeView>> {
    return this.acceptContext(this.batchRegistrations.get(owner), ref, questions)
  }

  private async acceptContext(registration: Registration | undefined, ref: NeedsContextReference, questions: RequestContextInput): Promise<DomainResult<ExchangeView>> {
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
    if (this.disposed || ![...this.registrations.values(), ...this.batchRegistrations.values()].includes(registration)) return failure(errorInfo.scope_conflict)
    const operationOwner = this.operationOwners.get(operationKey(ref.scope))
    if (operationOwner && operationOwner !== registration) return failure(errorInfo.scope_conflict)
    const result = this.store.register(ref.scope.mainSessionId, ref, parsed)
    if (typeof result === 'string') return failure(errorInfo[result])
    this.operationOwners.set(operationKey(ref.scope), registration)
    return { ok: true, value: view(result.record) }
  }

  async notifyMainAgent(owner: Context, ref: NeedsContextReference): Promise<boolean> {
    return this.notifyContext(this.registrations.get(owner), ref)
  }

  async notifyBatchMainAgent(owner: Context, ref: NeedsContextReference): Promise<boolean> {
    return this.notifyContext(this.batchRegistrations.get(owner), ref)
  }

  private async notifyContext(registration: Registration | undefined, ref: NeedsContextReference): Promise<boolean> {
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
    return this.finishContext(this.registrations.get(owner), ref, result)
  }

  async finishBatchOperation(owner: Context, ref: ExecutorOperationRef, result: 'completed' | 'needs_context' | 'unknown' | 'cancelled'): Promise<DomainResult<ExchangeView>> {
    return this.finishContext(this.batchRegistrations.get(owner), ref, result)
  }

  private async finishContext(registration: Registration | undefined, ref: ExecutorOperationRef, result: 'completed' | 'needs_context' | 'unknown' | 'cancelled'): Promise<DomainResult<ExchangeView>> {
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
    this.startResume(this.registrations.get(owner), ref, resolutionId)
  }

  batchResumeStarted(owner: Context, ref: ExecutorOperationRef, resolutionId: string): void {
    this.startResume(this.batchRegistrations.get(owner), ref, resolutionId)
  }

  private startResume(registration: Registration | undefined, ref: ExecutorOperationRef, resolutionId: string): void {
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

  batchCapabilities(): BatchExchangeCapabilities {
    const routeReady = !this.disposed && this.mainAgents.available
    const capability = (ready: boolean, reason: string) => ({ state: ready ? 'available' as const : 'unavailable' as const,
      version: ready ? BATCH_PROTOCOL : null, reason: ready ? null : routeReady ? reason : 'main_agent_route_unavailable' })
    return { batchProtocol: BATCH_PROTOCOL, exchange: capability(routeReady && this.batchRegistrations.size > 0, 'batch_executor_unavailable'),
      taskPhase: capability(routeReady && this.batchPhaseRegistrations.size > 0, 'batch_task_phase_inspector_unavailable') }
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
    this.disposed = true; this.mainAgents.dispose(); this.registrations.clear(); this.batchRegistrations.clear(); this.operationOwners.clear();
    this.phaseRegistrations.clear(); this.batchPhaseRegistrations.clear(); this.phaseRecords.clear()
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
    if (resolution.kind === 'answer' && existing.userStopped) return failure(errorInfo.invalid_state)
    if (resolution.kind === 'answer' && existing.budgetUsed > 0) return failure(errorInfo.budget_exhausted)
    const adapter = registration.adapter
    const ref = this.operationRef(existing)
    let phase: 'prepare' | 'register' | 'dispatch' = 'prepare'
    try {
      const prepared = await adapter.prepareResume(ref, resolutionId, fullRequest.expectedVersion, resolution)
      if (this.disposed || this.operationOwners.get(operationKey(fullRequest)) !== registration ||
        resolution.kind === 'answer' && this.store.get(fullRequest.mainSessionId, existing.exchangeId)?.userStopped) return failure(errorInfo.invalid_state)
      // Preparation is side-effect free. CAS is checked again after it, before Client registration.
      const resolved = this.store.resolve(fullRequest.mainSessionId, fullRequest, resolutionId, resolution)
      if (typeof resolved === 'string') return failure(errorInfo[resolved])
      phase = 'register'
      const registered = await adapter.registerResume(prepared)
      if (this.disposed || this.operationOwners.get(operationKey(fullRequest)) !== registration ||
        resolution.kind === 'answer' && this.store.get(fullRequest.mainSessionId, existing.exchangeId)?.userStopped) {
        this.store.markUnknown(fullRequest.mainSessionId, existing.exchangeId)
        return failure({ code: 'resume_registration_unknown', message: '续作登记期间执行端已卸载或用户已停止，未派发新调用。', stage: 'writeback' })
      }
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

export async function apply(ctx: Context): Promise<void> {
  let disposed = false
  ctx.effect(() => () => { disposed = true }, `${PACKAGE_NAME}.lifetime`)
  const exchange = new TranslationExchangeHostService(ctx)
  ctx.provide('translationExchange', exchange)
  ctx.effect(() => () => exchange.dispose(), `${PACKAGE_NAME}.exchange`)
  const hostPatch = await createHostPatchService(ctx)
  if (disposed) { await hostPatch.dispose(); return }
  ctx.provide('composerHostPatch', hostPatch)
  ctx.effect(() => () => hostPatch.dispose(), `${PACKAGE_NAME}.host-patch`)

  const contribution: TypertContribution = {
    package: PACKAGE_NAME,
    face: 'host',
    schemas: [],
    invocations: [...PLUGIN_REMOTE.descriptors, ...HOST_PATCH_REMOTE.descriptors],
    model: { services: [], events: [], objects: [] },
  }
  const unregister = ctx.typert.register(contribution)
  ctx.effect(() => () => unregister(), `${PACKAGE_NAME}.remote`)
  void hostPatch.start()
}
