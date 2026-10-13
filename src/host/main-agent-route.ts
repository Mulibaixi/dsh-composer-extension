import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { BatchTaskPhaseEvent, ExchangeResolution, ExchangeRequest, TaskPhaseEvent, TranslationExchangeService } from '../shared/contracts.js'

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'dsh-composer-exchange': { readonly kind: 'dsh-composer-exchange'; readonly exchangeId: string }
    'dsh-composer-task-phase': { readonly kind: 'dsh-composer-task-phase'; readonly eventId: string }
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
function jsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }
type AgentCtx = Agent['ctx'] & {
  tools: { register(definition: ReturnType<typeof defineTool>): () => void }
}

const identitySchema = { type: 'string' as const }
const requestParameters = {
  translationSessionId: { ...identitySchema, required: true as const },
  operationId: { ...identitySchema, required: true as const },
  exchangeId: { ...identitySchema, required: true as const },
  expectedVersion: { type: 'integer' as const, required: true as const },
}
const jsonOutput = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const messageContent = (record: { exchangeId: string; scope: ExchangeRequest; questions: { questions: readonly { type: string; range: { start: number; end: number } | null; question: string; reason: string }[] } }): string => {
  const questions = record.questions.questions.map((item, index) => `${index + 1}. ${item.question}（${item.type}${item.range ? `，原文码点 ${item.range.start}–${item.range.end}` : ''}；${item.reason}）`).join('\n')
  return `Composer 翻译补充通知（exchange ${record.exchangeId}）。请使用 translation_exchange_read 核对问题和版本；仅在已有材料足以回答时调用 translation_exchange_resolve。原文定位：${record.scope.translationSessionId}/${record.scope.operationId}。\n${questions}`
}

export interface MainAgentRouteHost {
  readonly ctx?: Context
  readonly controller: SessionController
  readonly exchange: TranslationExchangeService
  enqueueNotification(agent: Agent, exchangeId: string, messageId: string): boolean
  notificationClaimed(agent: Agent, exchangeId: string, messageId: string, turn: number): void
  notificationDiscarded(agent: Agent, exchangeId: string, messageId: string): void
  userStopped(agent: Agent, turn: number): void
  notificationCurrent(agent: Agent, exchangeId: string, messageId: string): boolean
  readonly taskPhase?: {
    read(agent: Agent, eventId: string): Promise<TaskPhaseEvent | BatchTaskPhaseEvent | null>
    enqueued(agent: Agent, eventId: string, messageId: string): boolean
    claimed(agent: Agent, eventId: string, messageId: string, turn: number): void
    discarded(agent: Agent, eventId: string, messageId: string): void
    current(agent: Agent, eventId: string, messageId: string): Promise<boolean>
  }
}

interface MountedAgent { readonly agent: Agent; readonly dispose: () => void; readonly messages: Map<string, string>; readonly phaseMessages: Map<string, string> }

/** Installs scoped tools on the exact SessionController Agent and queues one next-turn notice. */
export class MainAgentRoute {
  private readonly mounted = new Map<string, MountedAgent>()
  private readonly stopped = new Map<string, number>()
  private readonly stopEvents: (() => void) | undefined
  private disposed = false

  constructor(private readonly host: MainAgentRouteHost) {
    this.stopEvents = host.ctx?.on?.('session/event', (session, event: SessionEvent) => {
      if (event.type === 'turn/end' && event.data.reason.kind === 'aborted' && event.data.reason.reason.kind === 'user') {
        this.stopped.set(String(session.id), event.data.turn)
        const agent = this.mounted.get(String(session.id))?.agent
        if (agent) host.userStopped(agent, event.data.turn)
      } else if (event.type === 'user/message' && event.data.source.kind === 'user') this.stopped.delete(String(session.id))
    })
  }

  get available(): boolean { return !this.disposed && typeof this.host.controller?.resolveAgent === 'function' }

  async notify(mainSessionId: string, request: Omit<ExchangeRequest, 'mainSessionId'>): Promise<boolean> {
    if (this.disposed) return false
    const result = await this.host.controller.resolveAgent(mainSessionId as Agent['id'])
    if (!('agent' in result)) return false
    const agent = result.agent
    if (agent.id !== mainSessionId || agent.session.id !== mainSessionId) return false
    this.mount(agent)
    const stoppedTurn = this.stopped.get(mainSessionId)
    if (stoppedTurn !== undefined) {
      this.host.userStopped(agent, stoppedTurn)
      return false
    }
    const read = this.host.exchange.readForAgent(agent, request)
    if (!read.ok || read.value.status !== 'open' || read.value.notification !== 'not_enqueued' || read.value.userStopped) return false

    const message: UserMessage = createUserMessage({ content: [{ type: 'text', text: messageContent({
      exchangeId: read.value.exchangeId,
      scope: { mainSessionId, translationSessionId: read.value.scope.translationSessionId, operationId: read.value.scope.operationId,
        exchangeId: read.value.exchangeId, expectedVersion: read.value.version },
      questions: read.value.questions,
    }) }], source: { kind: 'dsh-composer-exchange', exchangeId: read.value.exchangeId } })
    if (!this.host.enqueueNotification(agent, read.value.exchangeId, message.id)) return false
    this.mounted.get(String(agent.id))!.messages.set(message.id, read.value.exchangeId)
    try {
      agent.followup(message)
      return true
    } catch {
      this.mounted.get(String(agent.id))?.messages.delete(message.id)
      this.host.notificationDiscarded(agent, read.value.exchangeId, message.id)
      return false
    }
  }

  owns(agent: Agent): boolean { return this.mounted.get(String(agent.id))?.agent === agent }

  /** A preparation notice uses the same native main-Agent queue, with its own fact and source. */
  async notifyTaskPhase(event: TaskPhaseEvent | BatchTaskPhaseEvent): Promise<boolean> {
    if (this.disposed || !this.host.taskPhase) return false
    const mainSessionId = event.scope.mainSessionId
    const result = await this.host.controller.resolveAgent(mainSessionId as Agent['id'])
    if (!('agent' in result) || this.disposed) return false
    const agent = result.agent
    if (agent.id !== mainSessionId || agent.session.id !== mainSessionId) return false
    this.mount(agent)
    const stoppedTurn = this.stopped.get(mainSessionId)
    if (stoppedTurn !== undefined) { this.host.userStopped(agent, stoppedTurn); return false }
    const fact = await this.host.taskPhase.read(agent, event.eventId)
    if (!fact || this.disposed || !this.owns(agent) || this.stopped.has(mainSessionId)) return false
    let content: string
    if ('coverageComplete' in fact) {
      const outcome = fact.phase === 'terminology_analysis_completed'
        ? fact.coverageComplete ? '分析完成，需译范围覆盖完整。' : '请求的局部分析完成，整篇准备覆盖尚未完成。'
        : fact.phase === 'terminology_analysis_failed' ? '分析已明确失败。' : '分析调用结果未知；请查询原调用，不得自动重新派发。'
      const reference = { target: { kind: 'material', mainSessionId, ...fact.result.material, sourceVersion: fact.result.sourceVersion }, analysisId: fact.result.analysisId,
        version: fact.result.version, operationId: fact.operationId, coverageComplete: fact.coverageComplete }
      content = `Composer 术语分析阶段通知。${outcome}请使用 translation_analysis_status 核对已固定材料的分析引用，使用 translation_analysis_read 按页读取候选、覆盖和调用记录，再继续处理原用户任务。阶段通知本身不表示准备包或整篇翻译已完成。\n${JSON.stringify(reference)}`
    } else {
      const outcome = fact.phase === 'document_context_required' ? '文档任务存在需要处理的关键疑点。'
        : fact.phase === 'document_dependencies_changed' ? '文档任务的准备或术语依赖发生变化。' : '整篇候选已到需要语义复核的阶段。'
      content = `Composer 文档任务阶段通知。${outcome}请使用 translation_batch_status 核对固定任务、源版本和任务序号，查询实际问题或候选后继续原用户任务。未知调用只查询原事实；此通知不授权重新派发或自动定稿。\n${JSON.stringify({ scope: fact.scope, operationId: fact.operationId, result: fact.result })}`
    }
    const message = createUserMessage({ content: [{ type: 'text', text: content }],
      source: { kind: 'dsh-composer-task-phase', eventId: fact.eventId } })
    if (!this.host.taskPhase.enqueued(agent, fact.eventId, message.id)) return false
    this.mounted.get(mainSessionId)!.phaseMessages.set(message.id, fact.eventId)
    try { agent.followup(message); return true }
    catch {
      this.mounted.get(mainSessionId)?.phaseMessages.delete(message.id)
      this.host.taskPhase.discarded(agent, fact.eventId, message.id)
      return false
    }
  }

  removeTaskPhaseNotification(mainSessionId: string, eventId: string, messageId: string): void {
    const mounted = this.mounted.get(mainSessionId)
    if (mounted?.phaseMessages.get(messageId) !== eventId) return
    if (mounted.agent.inbox.remove(messageId as never)) this.host.taskPhase?.discarded(mounted.agent, eventId, messageId)
    mounted.phaseMessages.delete(messageId)
  }

  async removeNotification(mainSessionId: string, exchangeId: string, messageId: string): Promise<void> {
    const mounted = this.mounted.get(mainSessionId)
    if (mounted && mounted.messages.get(messageId) === exchangeId && mounted.agent.inbox.remove(messageId as never)) {
      mounted.messages.delete(messageId)
      this.host.notificationDiscarded(mounted.agent, exchangeId, messageId)
      return
    }
    if (!mounted) {
      const result = await this.host.controller.resolveAgent(mainSessionId as Agent['id'])
      if ('agent' in result && result.agent.id === mainSessionId) result.agent.inbox.remove(messageId as never)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopEvents?.()
    for (const mounted of this.mounted.values()) {
      for (const [messageId, exchangeId] of mounted.messages) {
        if (mounted.agent.inbox.remove(messageId as never)) this.host.notificationDiscarded(mounted.agent, exchangeId, messageId)
      }
      for (const [messageId, eventId] of mounted.phaseMessages) {
        if (mounted.agent.inbox.remove(messageId as never)) this.host.taskPhase?.discarded(mounted.agent, eventId, messageId)
      }
      mounted.dispose()
    }
    this.mounted.clear()
    this.stopped.clear()
  }

  private mount(agent: Agent): void {
    const key = String(agent.id), current = this.mounted.get(key)
    if (current?.agent === agent) return
    current?.dispose()
    const ctx = agent.ctx as AgentCtx
    const disposers: (() => void)[] = []
    const exactAgent = (exec: { readonly agent?: Agent }): void => {
      if (exec.agent !== agent) throw new Error('exchange_agent_scope_mismatch')
    }
    const read = defineTool({
      name: 'translation_exchange_read',
      description: '读取当前主会话中指定翻译求助的问题、原文范围、版本与状态。每次回答前先读取最新版本。',
      parameters: requestParameters,
      output: jsonOutput,
      execute: async (args, exec) => {
        exactAgent(exec)
        const result = this.host.exchange.readForAgent(agent, args)
        if (!result.ok) throw new Error(result.error.code)
        return jsonValue(result.value)
      },
    })
    const status = defineTool({
      name: 'translation_exchange_status',
      description: '只查询指定翻译求助的当前状态和版本，不触发翻译模型。',
      parameters: requestParameters,
      output: jsonOutput,
      execute: async (args, exec) => {
        exactAgent(exec)
        const result = this.host.exchange.statusForAgent(agent, args)
        if (!result.ok) throw new Error(result.error.code)
        return jsonValue(result.value)
      },
    })
    const resolve = defineTool({
      name: 'translation_exchange_resolve',
      description: '按已读取的 exchange 版本提交简短答复、defer 或 abort。答复只限当前翻译问题；工具只返回短状态回执。',
      parameters: {
        ...requestParameters,
        resolutionId: { ...identitySchema, required: true as const },
        kind: { type: 'string' as const, enum: ['answer', 'defer', 'abort'] as const, required: true as const },
        answerText: { type: 'string' as const },
        organizedRequirements: { type: 'string' as const },
        references: { type: 'array' as const, items: { type: 'object' as const, additionalProperties: false, properties: {
          id: { type: 'string' as const, required: true as const }, version: { type: 'integer' as const, required: true as const },
        } } },
        reason: { type: 'string' as const },
      },
      output: jsonOutput,
      execute: async (args, exec) => {
        exactAgent(exec)
        const resolution: ExchangeResolution = args.kind === 'answer'
          ? { kind: 'answer', answerText: args.answerText ?? '', organizedRequirements: args.organizedRequirements ?? '', references: args.references ?? [] }
          : { kind: args.kind as 'defer' | 'abort', reason: args.reason ?? '' }
        const { resolutionId } = args
        const request = { translationSessionId: args.translationSessionId, operationId: args.operationId,
          exchangeId: args.exchangeId, expectedVersion: args.expectedVersion }
        const result = await this.host.exchange.resolveForAgent(agent, request, resolutionId, resolution)
        if (!result.ok) throw new Error(result.error.code)
        return jsonValue(result.value)
      },
    })
    disposers.push(ctx.tools.register(read), ctx.tools.register(resolve), ctx.tools.register(status))
    const messages = new Map<string, string>()
    const phaseMessages = new Map<string, string>()
    disposers.push(ctx.on('agent/inbox/discarded', ({ agent: subject, message }) => {
      if (subject === agent && message.source.kind === 'dsh-composer-exchange') {
        messages.delete(message.id)
        this.host.notificationDiscarded(agent, message.source.exchangeId, message.id)
      }
      if (subject === agent && message.source.kind === 'dsh-composer-task-phase') {
        phaseMessages.delete(message.id)
        this.host.taskPhase?.discarded(agent, message.source.eventId, message.id)
      }
    }))
    disposers.push(ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
      if (subject === agent && message.source.kind === 'dsh-composer-exchange') {
        messages.delete(message.id)
        this.host.notificationClaimed(agent, message.source.exchangeId, message.id, turn)
      }
      if (subject === agent && message.source.kind === 'dsh-composer-task-phase') {
        phaseMessages.delete(message.id)
        this.host.taskPhase?.claimed(agent, message.source.eventId, message.id, turn)
      }
    }))
    disposers.push(ctx.on('agent/pre-step', async ({ agent: subject, messages }, next) => {
      if (subject === agent && messages.length === 1) {
        const message = messages[0]!
        if (message.source.kind === 'dsh-composer-exchange' && !this.host.notificationCurrent(agent, message.source.exchangeId, message.id)) return { kind: 'reject' }
      }
      const decision = await next()
      if (subject !== agent || decision.kind === 'reject' || decision.messages.length === 0) return decision
      const retained = []
      for (const message of decision.messages) {
        if (message.source.kind === 'dsh-composer-exchange' &&
          !this.host.notificationCurrent(agent, message.source.exchangeId, message.id)) continue
        if (message.source.kind === 'dsh-composer-task-phase' &&
          !await this.host.taskPhase?.current(agent, message.source.eventId, message.id)) continue
        retained.push(message)
      }
      return retained.length ? { ...decision, messages: retained } : { kind: 'reject' }
    }))
    disposers.push(ctx.on('session/event', (session, event: SessionEvent) => {
      if (session !== agent.session || event.type !== 'turn/end') return
      const reason = event.data.reason
      if (reason.kind === 'aborted' && reason.reason.kind === 'user') {
        this.stopped.set(key, event.data.turn)
        this.host.userStopped(agent, event.data.turn)
      }
    }))
    const dispose = () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
    this.mounted.set(key, { agent, dispose, messages, phaseMessages })
  }
}
