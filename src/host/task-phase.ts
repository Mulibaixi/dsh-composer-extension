import type { TaskPhaseEvent } from '../shared/contracts.js'

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_task_phase')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) throw new TypeError('invalid_task_phase')
  return record
}
function id(value: unknown, maximum = 3000): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('invalid_task_phase_identity')
  return value
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError('invalid_task_phase_version')
  return value as number
}

/** The in-process boundary accepts only short immutable analysis references, never user text. */
export function parseTaskPhaseEvent(value: unknown): TaskPhaseEvent {
  const event = object(value, ['eventId', 'hostGeneration', 'scope', 'operationId', 'phase', 'result', 'coverageComplete'])
  const scope = object(event.scope, ['ownerId', 'mainSessionId', 'topicId', 'translationSessionId'])
  const result = object(event.result, ['kind', 'analysisId', 'version', 'sourceVersion', 'material'])
  const material = object(result.material, ['requestId', 'materialId'])
  if (result.kind !== 'analysis' || !['terminology_analysis_completed', 'terminology_analysis_failed', 'terminology_analysis_unknown'].includes(String(event.phase)) ||
    typeof event.coverageComplete !== 'boolean' || event.phase !== 'terminology_analysis_completed' && event.coverageComplete) throw new TypeError('invalid_task_phase')
  const parsed: TaskPhaseEvent = { eventId: id(event.eventId, 8192), hostGeneration: id(event.hostGeneration),
    scope: { ownerId: id(scope.ownerId), mainSessionId: id(scope.mainSessionId), topicId: id(scope.topicId), translationSessionId: id(scope.translationSessionId) },
    operationId: id(event.operationId), phase: event.phase as TaskPhaseEvent['phase'],
    result: { kind: 'analysis', analysisId: id(result.analysisId), version: version(result.version), sourceVersion: version(result.sourceVersion),
      material: { requestId: id(material.requestId), materialId: id(material.materialId) } }, coverageComplete: event.coverageComplete }
  if (parsed.scope.ownerId !== parsed.scope.mainSessionId || new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 32768) throw new TypeError('invalid_task_phase_scope')
  return parsed
}
