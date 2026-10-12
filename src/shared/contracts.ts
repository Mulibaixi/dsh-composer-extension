import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const COMPOSER_PROTOCOL = 1 as const
export const EXCHANGE_PROTOCOL = 1 as const
export const NORMAL_PROTOCOL = 2 as const
export const TASK_PHASE_PROTOCOL = 1 as const

export type CapabilityState = 'available' | 'unavailable' | 'unknown'
export type CapabilityKey = 'composer' | 'materialBridge' | 'normal' | 'exchange' | 'modelControl'

export interface Capability {
  readonly state: CapabilityState
  readonly version: number | null
  readonly reason: string | null
}

export interface ExchangeCapabilities {
  readonly exchangeProtocol: typeof EXCHANGE_PROTOCOL
  readonly capabilities: Readonly<Record<CapabilityKey, Capability>>
}

export interface ExchangeError {
  readonly code: string
  readonly message: string
  readonly stage: 'authorize' | 'prepare' | 'protocol' | 'notify' | 'resolve' | 'register_resume' | 'dispatch' | 'writeback'
}

export type DomainResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ExchangeError }

export interface ExchangeRequest {
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly operationId: string
  readonly exchangeId: string
  readonly expectedVersion: number
}

export interface ExchangeView {
  readonly exchangeId: string
  readonly version: number
  readonly status: 'open' | 'waiting_user' | 'resuming' | 'resolved' | 'cancelled' | 'unknown'
  readonly operationStatus: 'waiting_context' | 'waiting_user' | 'resuming' | 'running' | 'completed' | 'cancelled' | 'unknown'
  readonly lastSequence: number
}

export interface ExchangeAgentRead extends ExchangeView {
  readonly scope: ExchangeScope
  readonly callId: string
  readonly contextVersion: number
  readonly questions: RequestContextInput
  readonly notification: 'not_enqueued' | 'enqueued' | 'claimed' | 'read' | 'discarded'
  readonly notificationMessageId: string | null
  readonly notificationTurn: number | null
  readonly userStopped: boolean
}

export type RequestContextQuestionType = 'missing_context' | 'term_ambiguity' | 'requirement_conflict'

export interface RequestContextQuestion {
  readonly type: RequestContextQuestionType
  readonly range: null | { readonly start: number; readonly end: number }
  readonly question: string
  readonly reason: string
}

export interface RequestContextInput {
  readonly questions: readonly RequestContextQuestion[]
}

export interface ExchangeScope {
  readonly mainSessionId: string
  readonly topicId: string
  readonly translationSessionId: string
  readonly unitId: string
  readonly sourceVersion: number
  readonly operationId: string
}

export type ExchangeResolution =
  | { readonly kind: 'answer'; readonly answerText: string; readonly organizedRequirements: string; readonly references: readonly { readonly id: string; readonly version: number }[] }
  | { readonly kind: 'defer'; readonly reason: string }
  | { readonly kind: 'abort'; readonly reason: string }

export interface PreparedComposerContribution {
  prepare(signal: AbortSignal): Promise<void>
  finish(outcome: ComposerSubmissionOutcome): void
}

export interface ComposerSubmissionGesture {
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly mode: 'queue' | 'steer'
  readonly timestamp: number
  readonly source?: 'click' | 'enter'
  readonly draftRev: number
}

export type ComposerSubmissionOutcome = 'accepted' | 'failed' | 'handled' | 'cancelled' | 'unknown'

export interface ComposerSubmissionAdapter {
  readonly key: string
  freeze(gesture: ComposerSubmissionGesture): PreparedComposerContribution | undefined
}

export interface ExecutorOperationRef extends ExchangeScope {
  readonly callId: string
  readonly contextVersion: number
  readonly hostGeneration: string
  readonly lastSequence: number
  readonly exchangeId?: string
}

export interface PreparedExecutorResume {
  readonly candidateCallId: string | null
  readonly contextVersion: number
  readonly token: unknown
}

export interface ExecutorResumeRegistration {
  readonly candidateCallId: string | null
  readonly contextVersion: number
  readonly lastSequence: number
}

export interface ExecutorAdapter {
  inspectOperation(ref: ExecutorOperationRef): Promise<unknown>
  prepareResume(ref: ExecutorOperationRef, resolutionId: string, observedVersion: number, resolution: ExchangeResolution): Promise<PreparedExecutorResume>
  registerResume(prepared: PreparedExecutorResume): Promise<ExecutorResumeRegistration>
  dispatchResume(prepared: PreparedExecutorResume): Promise<{ readonly status: 'resuming' }>
  queryOperation(ref: ExecutorOperationRef): Promise<unknown>
  cancelOperation(ref: ExecutorOperationRef): Promise<unknown>
  authorizePeer?(mainSessionId: string, peerId: string): boolean
}

export interface NeedsContextReference {
  readonly scope: ExchangeScope
  readonly callId: string
  readonly contextVersion: number
  readonly hostGeneration: string
  readonly lastSequence: number
}

export interface ComposerExtensionService {
  capabilities(): Capability
  register(owner: Context, adapter: ComposerSubmissionAdapter): () => void
}

export interface TaskPhaseScope {
  readonly ownerId: string
  readonly mainSessionId: string
  readonly topicId: string
  readonly translationSessionId: string
}

/** No unit exists during independent preparation; only the exact analysis result is referenced. */
export interface TaskPhaseEvent {
  readonly eventId: string
  readonly hostGeneration: string
  readonly scope: TaskPhaseScope
  readonly operationId: string
  readonly phase: 'terminology_analysis_completed' | 'terminology_analysis_failed' | 'terminology_analysis_unknown'
  readonly result: { readonly kind: 'analysis'; readonly analysisId: string; readonly version: number; readonly sourceVersion: number;
    readonly material: { readonly requestId: string; readonly materialId: string } }
  readonly coverageComplete: boolean
}

export interface TaskPhaseInspector {
  inspectTaskPhase(event: TaskPhaseEvent): TaskPhaseEvent | null | Promise<TaskPhaseEvent | null>
}

export interface TaskPhaseCapability {
  readonly phaseProtocol: typeof TASK_PHASE_PROTOCOL
  readonly ready: boolean
  readonly reason: string | null
}

export interface TaskPhaseView {
  readonly eventId: string
  readonly state: 'not_enqueued' | 'enqueued' | 'claimed' | 'discarded' | 'unavailable'
}

export interface TranslationExchangeService {
  readonly hostGeneration: string
  /** Additive in-process port; exchangeProtocol and existing Remote methods stay at version 1. */
  registerTaskPhaseInspector(owner: Context, inspector: TaskPhaseInspector): () => void
  taskPhaseCapabilities(): TaskPhaseCapability
  notifyTaskPhase(owner: Context, event: TaskPhaseEvent): Promise<DomainResult<TaskPhaseView>>
  register(owner: Context, adapter: ExecutorAdapter): () => void
  acceptNeedsContext(owner: Context, ref: NeedsContextReference, questions: RequestContextInput): Promise<DomainResult<ExchangeView>>
  notifyMainAgent(owner: Context, ref: NeedsContextReference): Promise<boolean>
  finishOperation(owner: Context, ref: ExecutorOperationRef, result: 'completed' | 'needs_context' | 'unknown' | 'cancelled'): Promise<DomainResult<ExchangeView>>
  resumeStarted(owner: Context, ref: ExecutorOperationRef, resolutionId: string): void
  capabilities(): Promise<DomainResult<ExchangeCapabilities>>
  query(request: ExchangeRequest): Promise<DomainResult<ExchangeView>>
  cancel(request: ExchangeRequest): Promise<DomainResult<ExchangeView>>
  readForAgent(agent: import('@deepseek-ai/dsh-agent').Agent, request: Omit<ExchangeRequest, 'mainSessionId'>): DomainResult<ExchangeAgentRead>
  statusForAgent(agent: import('@deepseek-ai/dsh-agent').Agent, request: Omit<ExchangeRequest, 'mainSessionId'>): DomainResult<ExchangeView>
  resolveForAgent(agent: import('@deepseek-ai/dsh-agent').Agent, request: Omit<ExchangeRequest, 'mainSessionId'>,
    resolutionId: string, resolution: ExchangeResolution): Promise<DomainResult<ExchangeView>>
}
