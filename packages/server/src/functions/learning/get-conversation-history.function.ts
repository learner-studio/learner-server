import { defineFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { GetConversationHistoryInput, GetConversationHistoryOutput, readConversationHistory } from '@learner/core/functions/learning/get-conversation-history.js'
export * from '@learner/core/functions/learning/get-conversation-history.js'

export const getConversationHistory = defineFunction({
  title: 'Get Conversation History',
  description: 'Read the latest completed local Google/Antigravity, Anthropic/Claude, OpenAI/Codex, and optional remote conversation exchanges for debugging.',
  expose: true,
  readonly: true,
  input: GetConversationHistoryInput,
  output: GetConversationHistoryOutput,
  func: async (_services, input) => {
    assertLearningLocalMvpEnabled()
    const parsedInput = GetConversationHistoryInput.parse(input)
    const requestedLimit = parsedInput.limit
    const limit = typeof requestedLimit === 'string' ? Number(requestedLimit) : (requestedLimit ?? 50)
    return readConversationHistory(limit, parsedInput.conceptId)
  },
})
