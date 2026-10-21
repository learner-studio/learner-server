import type { ConversationTurn } from '../../functions/learning/get-conversation-history.js'

export const THREE_TURN_CONTEXT_STRATEGY = 'three-turn-retrospective-v1' as const
export const THREE_TURN_EXPERIMENT_LABEL = 'three-turn input luna medium vs luna high vs luna extra high' as const
export const ONE_PAIR_CONTEXT_STRATEGY = 'one-pair-target-response-v1' as const
export const ONE_PAIR_EXPERIMENT_LABEL = 'one-pair input luna medium matched to three-pair luna medium' as const
export const SEED_V1_CONTEXT_STRATEGY = 'seed-v1-operator-pairs-v1' as const
export const SEED_V1_EXPERIMENT_LABEL = 'seed V1 ours vs custom Hindsight Luna high' as const
export const SEED_V1_EFFECTIVE_CONTEXT_TOKENS = 258_400 as const
export const THREE_TURN_MAX_BATCH_TOKENS = 400_000 as const
export const THREE_TURN_ACTIVE_CONTEXT_TOKENS = 272_000 as const
export const THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS = 40_000 as const
export const THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING = 232_000 as const

export type ThreeTurnSequenceMessage = Pick<ConversationTurn,
  'id' | 'threadId' | 'exchangeId' | 'agent' | 'provider' | 'location' | 'role'
  | 'sourceRecordId' | 'sourceOrder' | 'authorship' | 'authorshipEvidence' | 'text' | 'timestamp' | 'model' | 'cwd'> & {
    sequenceNumber: number
    section: 'before' | 'target' | 'after'
    contextRelation: 'prior' | 'target' | 'retrospective_future'
  }

export type ThreeTurnSequence = {
  strategy: typeof THREE_TURN_CONTEXT_STRATEGY
  messages: ThreeTurnSequenceMessage[]
}

export type OnePairSequence = {
  strategy: typeof ONE_PAIR_CONTEXT_STRATEGY
  sourceStrategy: typeof THREE_TURN_CONTEXT_STRATEGY
  messages: [ThreeTurnSequenceMessage, ThreeTurnSequenceMessage]
}

export type SeedV1PairSequence = {
  strategy: typeof SEED_V1_CONTEXT_STRATEGY
  messages: [ThreeTurnSequenceMessage, ThreeTurnSequenceMessage]
}

const threadKey = (turn: ConversationTurn): string => [
  turn.provider,
  turn.location,
  turn.threadId,
  turn.agent,
].join(':')

/**
 * Build three adjacent, complete native exchanges without trusting provider
 * exchange IDs. A user-role turn is the boundary. Its paired response is the
 * final assistant-role turn before the next user boundary. An incomplete user
 * boundary invalidates every window spanning it; the builder never skips over
 * a gap or grafts a response from another thread.
 */
export function buildThreeTurnSequences(turns: ConversationTurn[]): ThreeTurnSequence[] {
  const threads = new Map<string, Array<{ turn: ConversationTurn; sourceOrder: number }>>()
  turns.forEach((turn, sourceOrder) => {
    const thread = threads.get(threadKey(turn)) ?? []
    thread.push({ turn, sourceOrder })
    threads.set(threadKey(turn), thread)
  })

  const sequences: ThreeTurnSequence[] = []
  for (const thread of threads.values()) {
    const seenSourceTurns = new Set<string>()
    const ordered = [...thread].sort((left, right) => (
      left.turn.timestamp.localeCompare(right.turn.timestamp)
      || left.turn.sourceOrder - right.turn.sourceOrder
      || left.turn.sourceRecordId.localeCompare(right.turn.sourceRecordId)
      || left.sourceOrder - right.sourceOrder
    )).flatMap(({ turn }) => {
      const sourceKey = `${turn.role}:${turn.id}`
      if (seenSourceTurns.has(sourceKey)) return []
      seenSourceTurns.add(sourceKey)
      return [turn]
    })
    const userIndexes = ordered.flatMap((turn, index) => turn.role === 'user' ? [index] : [])
    const exchanges = userIndexes.map((userIndex, boundaryIndex) => {
      const user = ordered[userIndex]!
      const nextUserIndex = userIndexes[boundaryIndex + 1] ?? ordered.length
      const assistant = ordered.slice(userIndex + 1, nextUserIndex)
        .filter((turn) => turn.role === 'assistant')
        .at(-1)
      return user.authorship === 'human' && assistant ? { user, assistant } : null
    })

    for (let index = 0; index + 2 < exchanges.length; index += 1) {
      const adjacent = exchanges.slice(index, index + 3)
      if (adjacent.some((exchange) => exchange === null)) continue
      const complete = adjacent as Array<{ user: ConversationTurn; assistant: ConversationTurn }>
      const sections = ['before', 'target', 'after'] as const
      const relations = ['prior', 'target', 'retrospective_future'] as const
      const messages = complete.flatMap((exchange, exchangeIndex) => (
        [exchange.user, exchange.assistant].map((turn, withinExchangeIndex) => ({
          id: turn.id,
          threadId: turn.threadId,
          exchangeId: turn.exchangeId,
          sourceRecordId: turn.sourceRecordId,
          sourceOrder: turn.sourceOrder,
          agent: turn.agent,
          provider: turn.provider,
          location: turn.location,
          role: turn.role,
          authorship: turn.authorship,
          authorshipEvidence: turn.authorshipEvidence,
          text: turn.text,
          timestamp: turn.timestamp,
          model: turn.model,
          cwd: turn.cwd,
          sequenceNumber: exchangeIndex * 2 + withinExchangeIndex + 1,
          section: sections[exchangeIndex]!,
          contextRelation: relations[exchangeIndex]!,
        }))
      ))
      sequences.push({ strategy: THREE_TURN_CONTEXT_STRATEGY, messages })
    }
  }
  return sequences
}

export function assertThreeTurnSequence(sequence: ThreeTurnSequence): void {
  if (sequence.strategy !== THREE_TURN_CONTEXT_STRATEGY || sequence.messages.length !== 6) {
    throw new Error('Three-turn context requires exactly six numbered messages')
  }
  const roles = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']
  const sections = ['before', 'before', 'target', 'target', 'after', 'after']
  const relations = ['prior', 'prior', 'target', 'target', 'retrospective_future', 'retrospective_future']
  const source = sequence.messages[0]
  for (const [index, message] of sequence.messages.entries()) {
    if (message.sequenceNumber !== index + 1 || message.role !== roles[index]
      || message.section !== sections[index] || message.contextRelation !== relations[index]) {
      throw new Error('Three-turn messages must be numbered alternating before, target, and after exchanges')
    }
    if (!source || message.provider !== source.provider || message.location !== source.location
      || message.threadId !== source.threadId || message.agent !== source.agent) {
      throw new Error('Three-turn messages must come from one native thread')
    }
    const previous = sequence.messages[index - 1]
    if (previous && (message.timestamp.localeCompare(previous.timestamp) < 0
      || (message.timestamp === previous.timestamp && message.sourceOrder <= previous.sourceOrder))) {
      throw new Error('Three-turn messages must increase by native timestamp and source order')
    }
  }
  if (sequence.messages[2]?.authorship !== 'human') throw new Error('Central learner message must have verified human authorship')
}

export function assertSeedV1PairSequence(sequence: SeedV1PairSequence): void {
  if (sequence.strategy !== SEED_V1_CONTEXT_STRATEGY || sequence.messages.length !== 2) {
    throw new Error('Seed V1 context requires exactly one two-message exchange')
  }
  const [learner, response] = sequence.messages
  if (!learner || !response || learner.role !== 'user' || learner.authorship !== 'human' || response.role !== 'assistant') {
    throw new Error('Seed V1 pair requires a verified human user target followed by an assistant response')
  }
  if (learner.provider !== response.provider || learner.threadId !== response.threadId) {
    throw new Error('Seed V1 pair cannot cross a provider or native thread boundary')
  }
}

/** Derive the matched context ablation from a frozen three-exchange window.
 * The target IDs, native provenance fields and bytes are copied unchanged;
 * only the neighboring exchanges are removed. */
export function buildOnePairSequence(sequence: ThreeTurnSequence): OnePairSequence {
  assertThreeTurnSequence(sequence)
  const user = sequence.messages[2]!
  const assistant = sequence.messages[3]!
  return {
    strategy: ONE_PAIR_CONTEXT_STRATEGY,
    sourceStrategy: THREE_TURN_CONTEXT_STRATEGY,
    messages: [
      { ...user, sequenceNumber: 1, section: 'target', contextRelation: 'target' },
      { ...assistant, sequenceNumber: 2, section: 'target', contextRelation: 'target' },
    ],
  }
}

export function assertOnePairSequence(sequence: OnePairSequence): void {
  if (sequence.strategy !== ONE_PAIR_CONTEXT_STRATEGY
    || sequence.sourceStrategy !== THREE_TURN_CONTEXT_STRATEGY
    || sequence.messages.length !== 2) {
    throw new Error('One-pair context requires exactly the frozen target user/assistant pair')
  }
  const [user, assistant] = sequence.messages
  if (!user || !assistant || user.sequenceNumber !== 1 || assistant.sequenceNumber !== 2
    || user.role !== 'user' || assistant.role !== 'assistant'
    || user.section !== 'target' || assistant.section !== 'target'
    || user.contextRelation !== 'target' || assistant.contextRelation !== 'target'
    || user.authorship !== 'human') {
    throw new Error('One-pair messages must be the numbered target human/assistant exchange')
  }
  if (user.provider !== assistant.provider || user.location !== assistant.location
    || user.threadId !== assistant.threadId || user.agent !== assistant.agent
    || assistant.timestamp.localeCompare(user.timestamp) < 0
    || (assistant.timestamp === user.timestamp && assistant.sourceOrder <= user.sourceOrder)) {
    throw new Error('One-pair messages must retain one native thread and increasing source order')
  }
}
