import { expect, test } from 'bun:test'
import { conversationExchanges, type ConversationThread } from './conversation-history-model'

const turn = (id: string, role: 'user' | 'assistant', timestamp: string, text = id, authorship: 'human' | 'agent' | 'system' | 'unknown' = role === 'user' ? 'human' : 'agent') => ({ id, role, authorship, authorshipEvidence: '', text, timestamp, model: null })
const thread = (id: string, turns: ConversationThread['turns']): ConversationThread => ({ id, title: id, agent: 'Claude', provider: 'anthropic', location: 'local', latestAt: turns.at(-1)?.timestamp ?? '', models: [], workspacePath: null, folderSegments: [], turns })

test('each user turn pairs with the assistant turn that answered it, oldest first across threads', () => {
  const history = { threads: [
    thread('b', [turn('b1', 'user', '2026-09-07T10:00:00Z'), turn('b2', 'assistant', '2026-09-07T10:00:05Z')]),
    thread('a', [turn('a3', 'assistant', '2026-09-07T09:00:09Z'), turn('a1', 'user', '2026-09-07T09:00:00Z'), turn('a2', 'user', '2026-09-07T09:00:04Z')]),
  ] }
  const exchanges = conversationExchanges(history)
  expect(exchanges.map((exchange) => exchange.user.id)).toEqual(['a1', 'a2', 'b1'])
  // a1 was never answered before the next question; a2 got a3; b1 got b2.
  expect(exchanges.map((exchange) => exchange.assistant?.id ?? null)).toEqual([null, 'a3', 'b2'])
  expect(exchanges[0]?.meta).toContain('Claude · anthropic')
})

test('agent-internal prompts are not exchanges: only human-authored user turns are listed', () => {
  const exchanges = conversationExchanges({ threads: [
    thread('g', [turn('g1', 'user', '2026-09-07T19:58:42Z', 'Follow the requested output format exactly.', 'unknown'), turn('g2', 'assistant', '2026-09-07T19:58:42Z', 'bc84f8ae-6a60')]),
    thread('s', [turn('s1', 'user', '2026-09-07T19:59:00Z', '<task-notification>', 'system'), turn('s2', 'assistant', '2026-09-07T19:59:01Z')]),
    thread('h', [turn('h1', 'user', '2026-09-07T20:00:00Z', 'how do I frame the decision?', 'human'), turn('h2', 'assistant', '2026-09-07T20:00:05Z', 'Start from the estimand.')]),
  ] })
  expect(exchanges.map((exchange) => exchange.user.id)).toEqual(['h1'])
})
