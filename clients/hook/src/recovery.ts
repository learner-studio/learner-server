import { readFile, writeFile, unlink } from 'node:fs/promises'
import { BeginLearningFeedbackTurnWire, LearningFeedbackBeginPacket, LIVE_FEEDBACK_INSTRUCTIONS } from '@learner/contract'
import type { Catalog } from './catalog.js'

export function isTransientLearningFailure(error: unknown) {
  if (!(error instanceof Error)) return false
  return ['TimeoutError', 'AbortError', 'TypeError', 'ConnectionRefused'].includes(error.name) || /HTTP 5\d\d:/.test(error.message)
}

/** A durable request, not a cached assessment: the server still owns all validation and state. */
export async function deferLearningTurn(path: string, raw: unknown, catalog: Catalog) {
  const input = BeginLearningFeedbackTurnWire.parse(raw)
  await writeFile(path, JSON.stringify(input), { mode: 0o600 })
  return LearningFeedbackBeginPacket.parse({
    turnId: input.turnId, catalogVersion: catalog.catalogVersion,
    catalog: input.catalogVersion === catalog.catalogVersion ? null : catalog.catalog,
    instructions: LIVE_FEEDBACK_INSTRUCTIONS, recentFeedback: [],
  })
}

export async function resumeLearningTurn(path: string, identity: { sessionId: string; turnId: string; catalogVersion: string }, post: (name: 'beginLearningFeedbackTurn', data: unknown) => Promise<unknown>) {
  const text = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return
  const input = BeginLearningFeedbackTurnWire.parse(JSON.parse(text))
  if (input.sessionId !== identity.sessionId || input.turnId !== identity.turnId) throw new Error('Deferred Learning turn identity mismatch')
  // Same ID and exact bytes also safely recover a request committed after timeout.
  const packet = LearningFeedbackBeginPacket.parse(await post('beginLearningFeedbackTurn', input))
  if (packet.turnId !== identity.turnId || packet.catalogVersion !== identity.catalogVersion) throw new Error('Deferred Learning catalog or turn changed')
  await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error })
}
