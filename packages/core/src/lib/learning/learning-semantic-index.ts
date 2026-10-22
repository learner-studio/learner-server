import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { LearningIndexStatus } from '@learner/contract/learning/learning-index-status.js'
import type { ExposureObservation } from './learning-exposure-schemas.js'
import { hindsightHfHome, hindsightPython } from './hindsight-database.js'

export const LEARNING_SEMANTIC_BANK = 'learning-live-archive-v1'
export const LEARNING_BGE_TOKENIZER = `${hindsightHfHome()}/hub/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/tokenizer.json`
export const semanticHash = (text: string) => createHash('sha256').update(text).digest('hex')
const HindsightIndexOperationStatus = z.object({ status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled', 'not_found']) })
export async function readHindsightIndexOperationStatus(response: Response) {
  if (response.status === 404) return 'not_found' as const
  if (!response.ok) throw new Error(`Hindsight operation lookup HTTP ${response.status}`)
  return HindsightIndexOperationStatus.parse(await response.json()).status
}
export const semanticOperationId = (chunkId: string) => {
  const hash = semanticHash(`learning-semantic-index-v1:${chunkId}`)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function canonicalSemanticMessage(observation: ExposureObservation, rawVersionId: string) {
  const parts: Array<{ ordinal: number; startOffset: number; endOffset: number }> = []
  let text = ''
  for (const part of observation.parts.filter(part => part.type === 'text')) {
    if (parts.length) text += '\n'
    const startOffset = text.length
    text += part.text ?? ''
    parts.push({ ordinal: part.ordinal, startOffset, endOffset: text.length })
  }
  const correlation = observation.correlation
  const conversation = ['conversationId', 'codexThreadId', 'sessionId', 'sessionKey', 'threadId', 'nativeConversationId']
    .map(key => correlation[key]).find(value => typeof value === 'string' && value.length)
  const logicalMessageKey = observation.logicalMessageKey ?? observation.observationId
  return { messageId: semanticHash(`${logicalMessageKey}:${observation.direction}:${semanticHash(JSON.stringify(observation))}`),
    observationId: observation.observationId, logicalMessageKey, rawVersionId,
    conversationId: typeof conversation === 'string' ? conversation : `unlinked:${logicalMessageKey}`,
    role: observation.direction === 'user_to_model' ? 'user' as const : 'assistant' as const,
    observedAt: observation.observedAt, text, sourceSha256: semanticHash(text), parts,
    mediaCount: observation.parts.filter(part => part.type === 'media').length,
    unsupported: observation.parts.some(part => part.textOmitted || (part.type === 'text' && part.text === undefined)),
  }
}

export const SemanticTokenization = z.object({ tokenizerSha256: z.string(), chunks: z.array(z.object({
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), tokenCount: z.number().int().max(480),
})) })
export async function tokenizeSemanticTexts(texts: string[], config: { python?: string; tokenizerPath?: string } = {}) {
  const child = spawn(config.python ?? hindsightPython(),
    [fileURLToPath(new URL('./learning-semantic-index-tokenize.py', import.meta.url)), config.tokenizerPath ?? LEARNING_BGE_TOKENIZER],
    { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '8',
      OPENBLAS_NUM_THREADS: '8', MKL_NUM_THREADS: '8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } })
  const output = await new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    child.stdout.on('data', data => stdout.push(Buffer.from(data)))
    child.stderr.on('data', data => stderr.push(Buffer.from(data)))
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(Buffer.concat(stdout).toString())
      : reject(new Error(`Offline tokenizer failed (${code}): ${Buffer.concat(stderr).toString().slice(0, 1000)}`)))
    child.stdin.on('error', reject)
    child.stdin.end(JSON.stringify({ texts }))
  })
  const parsed = z.array(SemanticTokenization).parse(JSON.parse(output))
  if (parsed.length !== texts.length) throw new Error('Tokenizer omitted source messages')
  for (const [index, message] of parsed.entries()) {
    const text = texts[index]!
    let offset = 0
    for (const chunk of message.chunks) {
      if (chunk.startOffset !== offset || chunk.endOffset <= offset || chunk.endOffset > text.length) throw new Error('Tokenizer source coverage mismatch')
      offset = chunk.endOffset
    }
    if (offset !== text.length) throw new Error('Tokenizer dropped source text')
  }
  return parsed
}
export async function tokenizeSemanticText(text: string, config: { python?: string; tokenizerPath?: string } = {}) {
  return (await tokenizeSemanticTexts([text], config))[0]!
}

export const LearningSemanticSource = z.object({
  messageId: z.string(), observationId: z.string(), logicalMessageKey: z.string(), rawVersionId: z.string(),
  conversationId: z.string(), role: z.enum(['user', 'assistant']), observedAt: z.string(), text: z.string(),
})
export const LearningSemanticHit = LearningSemanticSource.omit({ text: true }).extend({
  chunkId: z.string(), snippet: z.string(), score: z.number().nullable(), startOffset: z.number(), endOffset: z.number(),
})
export const LearningSemanticHydration = LearningSemanticSource.extend({
  chunkId: z.string(), chunkText: z.string(), startOffset: z.number(), endOffset: z.number(), neighbors: z.array(LearningSemanticSource),
})
export { LearningIndexStatus }
export const LearningIndexRunInput = z.object({ runId: z.string().uuid() })
export const LearningIndexBatch = z.object({ runId: z.string().uuid(), pending: z.number(), errors: z.number(), processed: z.number() })
export const LearningIndexOperationInput = z.object({ runId: z.string().uuid(), operationId: z.string().uuid().nullable() })
export const LearningIndexOperationOutput = LearningIndexBatch.extend({ operationPending: z.boolean() })
export const LearningIndexPlan = z.object({ runId: z.string().uuid(), firstOperationId: z.string().uuid().nullable(), operationIds: z.array(z.string().uuid()), pollPasses: z.array(z.number()) })
export const LearningIndexFreezeInput = z.object({ runId: z.string().uuid(), maxMessages: z.number().int().min(1).max(100).optional() })
