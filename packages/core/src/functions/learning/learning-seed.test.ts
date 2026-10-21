import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterConceptExchanges, GetConversationHistoryInput, parseAnthropicHistory, parseAnthropicTranscript, parseAntigravityNativeRows, parseGoogleHistory, parseOpenAIHistory, parseOpenAISession, readOpenAISessionSlice } from './get-conversation-history.js'
import { normalizeLearningHook } from '../../lib/learning/learning-hooks.js'

test('Computer Science curriculum is broad, atomic, dependency-safe, and concept-first', async () => {
  const { COMPUTER_SCIENCE } = await import('./computer-science-seed.js')
  const laneIds = new Set(COMPUTER_SCIENCE.curriculum.lanes.map((lane) => lane.id))
  const moduleIds = new Set(COMPUTER_SCIENCE.curriculum.modules.map((module) => module.id))
  const conceptIds = new Set(COMPUTER_SCIENCE.concepts.map((concept) => concept.id))

  assert.equal(COMPUTER_SCIENCE.curriculum.id, 'computer-science')
  assert.ok(COMPUTER_SCIENCE.curriculum.lanes.length >= 13, 'the map should expose at least thirteen parallel lanes')
  assert.ok(COMPUTER_SCIENCE.curriculum.modules.length >= 70, 'the map should contain at least seventy conceptual modules')
  assert.ok(COMPUTER_SCIENCE.concepts.length >= 350, 'the map should contain at least 350 atomic concepts')
  assert.ok(COMPUTER_SCIENCE.edges.length >= 400, 'the nonlinear graph should make concept relationships explicit')
  assert.equal(conceptIds.size, COMPUTER_SCIENCE.concepts.length, 'concept IDs must be globally unique')
  assert.ok(
    COMPUTER_SCIENCE.concepts.every((concept) => concept.title.trim().split(/\s+/).length <= 5),
    'atomic concept labels should remain a few words long',
  )

  const dataScience = COMPUTER_SCIENCE.curriculum.lanes.find((lane) => lane.id === 'data-science')
  assert.ok(dataScience, 'data science is the first and deepest applied lane')
  assert.equal(dataScience.order, 1)
  assert.ok(
    COMPUTER_SCIENCE.curriculum.modules.filter((module) => module.laneId === dataScience.id).length >= 14,
    'data science should receive the deepest module treatment',
  )

  for (const module of COMPUTER_SCIENCE.curriculum.modules) {
    assert.ok(laneIds.has(module.laneId), `${module.id} must belong to a real lane`)
    assert.ok(module.conceptIds.length > 0, `${module.id} must contain the concepts needed by its lesson, without a size quota`)
    assert.ok(module.masteryGoals.length >= 2, `${module.id} must state conceptual mastery outcomes`)
    assert.ok(
      module.masteryGoals.every((goal) => /explain|predict|compare|reason|diagnose|evaluate|trace|distinguish|design/i.test(goal)),
      `${module.id} mastery should test a mental model rather than rote execution`,
    )
    assert.ok(module.conceptIds.every((id) => conceptIds.has(id)), `${module.id} references an unknown concept`)
    assert.ok(module.dependsOnModuleIds.every((id) => moduleIds.has(id) && id !== module.id), `${module.id} has an invalid dependency`)
  }

  for (const edge of COMPUTER_SCIENCE.edges) {
    assert.ok(conceptIds.has(edge.from) && conceptIds.has(edge.to), `${edge.from} -> ${edge.to} must reference real concepts`)
    assert.notEqual(edge.from, edge.to, 'concept edges must not self-reference')
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const dependencies = new Map(COMPUTER_SCIENCE.curriculum.modules.map((module) => [module.id, module.dependsOnModuleIds]))
  const visit = (id: string): void => {
    assert.ok(!visiting.has(id), `module dependency cycle includes ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of dependencies.get(id) ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of moduleIds) visit(id)
})

test('conversation readers preserve raw user and assistant text without extraction', async () => {
  const anthropic = parseAnthropicTranscript([
    JSON.stringify({ type: 'custom-title', sessionId: 'thread-1', customTitle: 'HTTP study' }),
    JSON.stringify({ type: 'user', sessionId: 'thread-1', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', model: 'claude-sonnet-4-5', content: 'What is DNS?' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'thread-1', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'It maps names to addresses.' }] } }),
    JSON.stringify({ type: 'user', sessionId: 'thread-1', isMeta: true, message: { role: 'user', content: 'omit this' } }),
  ].join('\n'), '/tmp/http-study.jsonl')
  assert.deepEqual(anthropic.map((turn) => turn.text), ['What is DNS?', 'It maps names to addresses.'])
  assert.equal(anthropic[0]?.threadTitle, 'HTTP study')
  assert.equal(anthropic[0]?.location, 'local')
  assert.equal(anthropic[0]?.authorship, 'human')
  assert.equal(anthropic[1]?.exchangeId, 'u1')
  assert.equal(anthropic[1]?.model, 'claude-sonnet-4-5')

  const openai = parseOpenAIHistory(JSON.stringify({ session_id: 'codex-1', ts: 1767225600, model: 'gpt-5', text: 'Explain HTTP.' }))
  assert.equal(openai[0]?.provider, 'openai')
  assert.equal(openai[0]?.role, 'user')
  assert.equal(openai[0]?.text, 'Explain HTTP.')
  assert.equal(openai[0]?.model, 'gpt-5')

  const claudeHistory = parseAnthropicHistory([
    JSON.stringify({ display: '/model', timestamp: 1, sessionId: 'claude-1' }),
    JSON.stringify({ display: '[Pasted text #1 +1 line] What follows?', pastedContents: { 1: { type: 'text', content: 'A queue stores work.' } }, timestamp: 2, sessionId: 'claude-1', project: '/root/example-workspace' }),
  ].join('\n'))
  assert.equal(claudeHistory.length, 1)
  assert.equal(claudeHistory[0]?.text, 'A queue stores work. What follows?')
  assert.equal(claudeHistory[0]?.authorship, 'human')
  assert.match(claudeHistory[0]?.authorshipEvidence ?? '', /submitted prompts only/)

  const session = parseOpenAISession([
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-session-1', cwd: '/tmp/http-study', originator: 'codex-tui' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'response_item', payload: {
      type: 'message', id: 'user-1', role: 'user', model: 'gpt-5-codex', content: [{ type: 'input_text', text: 'Explain HTTP.' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', content_item_kinds: ['user.text'] },
    } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item', payload: {
      type: 'message', id: 'assistant-1', role: 'assistant', content: [{ type: 'output_text', text: 'HTTP carries messages between clients and servers.' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    } }),
  ].join('\n'), '/tmp/codex-session.jsonl')
  assert.deepEqual(session.map((turn) => turn.role), ['user', 'assistant'])
  assert.deepEqual(session.map((turn) => turn.exchangeId), ['turn-1', 'turn-1'])
  assert.equal(session[1]?.text, 'HTTP carries messages between clients and servers.')
  assert.equal(session[0]?.model, 'gpt-5-codex')
  assert.equal(session[0]?.authorship, 'human')

  const injectedOpenAI = parseOpenAISession([
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'lane-1', originator: 'codex-lane' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Agent task instruction' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>injected</environment_context>' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] } } }),
  ].join('\n'), '/tmp/lane.jsonl')
  assert.deepEqual(injectedOpenAI.map((turn) => turn.authorship), ['agent', 'system'])

  const sidechain = parseAnthropicTranscript(JSON.stringify({ type: 'user', isSidechain: true, agentId: 'reviewer', sessionId: 'thread-2', message: { role: 'user', content: '<teammate-message>review this</teammate-message>' } }), '/tmp/claude.jsonl')
  assert.equal(sidechain[0]?.authorship, 'agent')

  const queued = parseAnthropicTranscript(JSON.stringify({
    type: 'attachment',
    uuid: 'queued-1',
    sessionId: 'thread-3',
    timestamp: '2026-09-04T12:00:00.000Z',
    attachment: {
      type: 'queued_command',
      prompt: 'Please inspect the parser next.',
      commandMode: 'prompt',
      origin: { kind: 'human' },
    },
  }), '/tmp/claude.jsonl')
  assert.equal(queued.length, 1)
  assert.equal(queued[0]?.role, 'user')
  assert.equal(queued[0]?.authorship, 'human')
  assert.equal(queued[0]?.text, 'Please inspect the parser next.')

  const taskNotification = parseAnthropicTranscript(JSON.stringify({
    type: 'attachment',
    sessionId: 'thread-3',
    attachment: {
      type: 'queued_command',
      prompt: '<task-notification>done</task-notification>',
      commandMode: 'task-notification',
    },
  }), '/tmp/claude.jsonl')
  assert.equal(taskNotification.length, 0)

  const google = parseGoogleHistory([
    JSON.stringify({ display: '/model', type: 'slash_command', timestamp: 1, conversationId: 'google-1' }),
    JSON.stringify({ display: 'Explain the system boundary.', timestamp: 2, conversationId: 'google-1', workspace: '/root' }),
  ].join('\n'))
  assert.equal(google.length, 1)
  assert.equal(google[0]?.provider, 'google')
  assert.equal(google[0]?.authorship, 'human')

  const { latestWorkspacePath, normalizeWorkspacePath } = await import('./get-conversation-history.js')
  assert.equal(typeof normalizeWorkspacePath, 'function', 'thread workspace path should be normalized')
  assert.deepEqual(normalizeWorkspacePath('/workspaces//./biztools/learning/'), {
    workspacePath: '/workspaces/biztools/learning',
    folderSegments: ['workspaces', 'biztools', 'learning'],
  })
  assert.deepEqual(normalizeWorkspacePath('/workspaces/biztools/tmp/../learning'), {
    workspacePath: '/workspaces/biztools/learning',
    folderSegments: ['workspaces', 'biztools', 'learning'],
  })
  assert.deepEqual(normalizeWorkspacePath(null), { workspacePath: null, folderSegments: [] })
  assert.deepEqual(latestWorkspacePath([
    { cwd: '/workspaces/old', timestamp: '2026-01-01T00:00:00.000Z' },
    { cwd: null, timestamp: '2026-01-01T00:00:01.000Z' },
    { cwd: '/workspaces/new', timestamp: '2026-01-01T00:00:02.000Z' },
  ]), {
    workspacePath: '/workspaces/new',
    folderSegments: ['workspaces', 'new'],
  })
})

test('bounded OpenAI session reads preserve head provenance while taking recent messages from the tail', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'learning-openai-tail-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'session.jsonl')
  const meta = JSON.stringify({ type: 'session_meta', payload: { session_id: 'recent-session', originator: 'codex-tui' } })
  const filler = Array.from({ length: 20 }, (_, index) => JSON.stringify({ type: 'event_msg', payload: { index, padding: 'x'.repeat(80) } }))
  const user = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Recent human prompt' }], internal_chat_message_metadata_passthrough: { turn_id: 'turn-recent', content_item_kinds: ['user.text'] } } })
  const assistant = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recent response' }], internal_chat_message_metadata_passthrough: { turn_id: 'turn-recent' } } })
  await writeFile(filePath, [meta, ...filler, user, assistant].join('\n'))
  const turns = parseOpenAISession(await readOpenAISessionSlice(filePath, 700), filePath)
  assert.deepEqual(turns.map((turn) => turn.authorship), ['human', 'agent'])
  assert.deepEqual(turns.map((turn) => turn.text), ['Recent human prompt', 'Recent response'])
})

const protobufVarint = (value: number): Buffer => {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

const protobufField = (field: number, value: number | string | Buffer): Buffer => {
  if (typeof value === 'number') return Buffer.concat([protobufVarint(field * 8), protobufVarint(value)])
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([protobufVarint((field * 8) + 2), protobufVarint(bytes.length), bytes])
}

test('Antigravity native SQLite steps recover exchanges and only certify readline-matched humans', () => {
  const seconds = 1_767_225_600
  const metadata = (id: string, offset = 0) => Buffer.concat([
    protobufField(1, Buffer.concat([protobufField(1, seconds + offset), protobufField(2, 0)])),
    protobufField(12, id),
  ])
  const nativeUser = (text: string) => protobufField(19, Buffer.concat([
    protobufField(2, text),
    protobufField(12, 'file:///root/example-workspace'),
  ]))
  const nativeAssistant = (text: string) => protobufField(20, protobufField(1, text))
  const readlineTurns = parseGoogleHistory(JSON.stringify({
    display: 'Explain the event loop.',
    timestamp: seconds * 1_000,
    conversationId: 'google-native-1',
    workspace: '/root/example-workspace',
  }))

  const turns = parseAntigravityNativeRows('google-native-1', [
    { idx: 1, step_type: 14, status: 1, metadata: metadata('prompt-1'), step_payload: nativeUser('Explain the event loop.') },
    { idx: 2, step_type: 15, status: 1, metadata: metadata('answer-1', 1), step_payload: nativeAssistant('The event loop schedules queued work.') },
    { idx: 3, step_type: 14, status: 1, metadata: metadata('prompt-2', 2), step_payload: nativeUser('Agent-generated follow-up') },
  ], readlineTurns)

  assert.deepEqual(turns.map((turn) => turn.role), ['user', 'assistant', 'user'])
  assert.deepEqual(turns.map((turn) => turn.authorship), ['human', 'agent', 'unknown'])
  assert.deepEqual(turns.slice(0, 2).map((turn) => turn.exchangeId), ['prompt-1', 'prompt-1'])
  assert.equal(turns[0]?.cwd, '/root/example-workspace')
  assert.equal(turns[1]?.text, 'The event loop schedules queued work.')
  assert.match(turns[0]?.authorshipEvidence ?? '', /matched TUI readline submission/)
  assert.match(turns[2]?.authorshipEvidence ?? '', /no matching TUI readline submission/)
})

test('conversation history accepts numeric RPC and query-string limits', () => {
  assert.equal(GetConversationHistoryInput.parse({ limit: 50 }).limit, 50)
  assert.equal(GetConversationHistoryInput.parse({ limit: '50' }).limit, '50')
  assert.equal(GetConversationHistoryInput.parse({ limit: 200, conceptId: 'url' }).conceptId, 'url')
  assert.throws(() => GetConversationHistoryInput.parse({ limit: '201' }))
})

test('concept filtering retains the complete matching user and assistant exchange', () => {
  const turns = parseAnthropicTranscript([
    JSON.stringify({ type: 'user', sessionId: 'thread-1', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'Explain a URL.' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'thread-1', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'A URL identifies a resource.' }] } }),
    JSON.stringify({ type: 'user', sessionId: 'thread-1', uuid: 'u2', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'user', content: 'Explain DNS.' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'thread-1', uuid: 'a2', timestamp: '2026-01-01T00:01:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'DNS resolves names.' }] } }),
  ].join('\n'), '/tmp/http-study.jsonl')
  assert.deepEqual(filterConceptExchanges(turns, 'url').map((turn) => turn.id), ['u1', 'a1'])
})

test('provider hooks normalize Claude turns into stable canonical events', () => {
  const userPayload = {
    session_id: 'claude-session-1',
    prompt_id: 'prompt-1',
    transcript_path: '/tmp/claude-session-1.jsonl',
    cwd: '/tmp/http-study',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'What does an HTTP request contain?',
  }
  const user = normalizeLearningHook('anthropic', userPayload, '2026-01-01T00:00:00.000Z')
  assert.equal(user.events[0]?.role, 'user')
  assert.equal(user.events[0]?.text, userPayload.prompt)
  assert.equal(user.events[0]?.model, null)
  assert.equal(user.events[0]?.exchangeId, 'prompt-1')
  assert.equal(user.events[0]?.id, normalizeLearningHook('anthropic', userPayload, '2026-01-01T00:00:01.000Z').events[0]?.id)

  const assistant = normalizeLearningHook('anthropic', {
    ...userPayload,
    hook_event_name: 'Stop',
    last_assistant_message: 'It contains a method, target, headers, and optional body.',
  }, '2026-01-01T00:00:02.000Z')
  assert.equal(assistant.events[0]?.role, 'assistant')
  assert.equal(assistant.events[0]?.text, 'It contains a method, target, headers, and optional body.')
  assert.equal(assistant.events[0]?.provider, 'anthropic')
})

test('OpenAI provider variation accepts a bridge payload without changing the canonical event', () => {
  const result = normalizeLearningHook('openai', {
    event: 'turn.completed',
    session_id: 'codex-session-1',
    turn_id: 'turn-1',
    role: 'assistant',
    text: 'HTTP responses include a status code and headers.',
    model: 'gpt-5-codex',
    agent: 'Codex',
  }, '2026-01-01T00:00:00.000Z')
  assert.equal(result.events[0]?.provider, 'openai')
  assert.equal(result.events[0]?.exchangeId, 'turn-1')
  assert.equal(result.events[0]?.role, 'assistant')
  assert.equal(result.events[0]?.text, 'HTTP responses include a status code and headers.')
  assert.equal(result.events[0]?.model, 'gpt-5-codex')
})
