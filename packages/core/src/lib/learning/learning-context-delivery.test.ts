import { expect, test } from 'bun:test'
import { learningContextParts, learningNativeHookOutput, learningCliPrompt } from './learning-context-delivery.js'
import { liveCatalogContexts, liveFeedbackInlineControl } from './learning-live-hook.js'
import { LIVE_CATALOG, LIVE_CATALOG_VERSION } from './learning-live-catalog.js'
import { LIVE_FEEDBACK_INSTRUCTIONS } from './learning-live-feedback.js'
import { AGENTS } from '@learner/llm/lib/cli/cli-agents.js'

test('large Unicode context is lossless and every hook stays inline', () => {
  const text = '🧠 HTTP café\n'.repeat(5000)
  const parts = learningContextParts(text)
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.map(p => p.slice(p.indexOf('\n') + 1)).join('')).toBe(text)
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(8000)
    for (const provider of ['claude','codex'] as const) expect(learningNativeHookOutput(provider,part)).toEqual({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:part}})
  }
  expect(() => learningNativeHookOutput('claude', text)).toThrow('budget')
  expect(learningNativeHookOutput('codex', '')).toEqual({})
})

test('real 664-concept catalog and actionable control fit separately without dropping IDs', () => {
  const parts = liveCatalogContexts(LIVE_CATALOG,LIVE_CATALOG_VERSION)
  const text = parts.map(p => p.slice(p.indexOf('\n') + 1)).join('')
  expect(text).toBe(LIVE_CATALOG.map(c=>`${c.id} | ${c.title}`).join('\n'))
  const packet = {turnId:crypto.randomUUID(),catalogVersion:LIVE_CATALOG_VERSION,catalog:LIVE_CATALOG,instructions:LIVE_FEEDBACK_INSTRUCTIONS,recentFeedback:[]}
  const control = liveFeedbackInlineControl(packet,crypto.randomUUID())
  const serialized = JSON.stringify(control)
  expect(serialized.length).toBeLessThan(8000)
  expect(serialized.indexOf('--submit')).toBeLessThan(1000)
  expect(serialized.indexOf(packet.turnId)).toBeLessThan(1000)
  expect(parts.every(p => p.length <= 8000)).toBe(true)
})

test('shared harness context remains intact in existing AGY stdin encoder', () => {
  const prompt = learningCliPrompt('Learning: HTTP is provisional, not mastery.','User: explain HTTP.')
  const encoded = AGENTS.AGY.formatStdin(prompt)
  expect(JSON.parse(encoded).message.content.endsWith(prompt)).toBe(true)
  expect(learningCliPrompt('', 'unchanged')).toBe('unchanged')
})

test('long feedback history is trimmed to the inline budget instead of failing the turn', () => {
  const gap = 'Does not say how much quality loss is acceptable for a speed gain, which is what picks one point on the Pareto front.'
  const turn = () => ({turnId:crypto.randomUUID(),matches:LIVE_CATALOG.slice(0,5).map(c=>({conceptId:c.id,outcome:'partial',remainingGap:gap})),taughtConceptIds:LIVE_CATALOG.slice(0,4).map(c=>c.id)})
  const history = [turn(),turn(),turn()]
  const packet = {turnId:crypto.randomUUID(),catalogVersion:LIVE_CATALOG_VERSION,catalog:LIVE_CATALOG,instructions:LIVE_FEEDBACK_INSTRUCTIONS,recentFeedback:history}
  const context = (liveFeedbackInlineControl(packet,crypto.randomUUID()) as {hookSpecificOutput:{additionalContext:string}}).hookSpecificOutput.additionalContext
  expect(context.length).toBeLessThanOrEqual(8000)
  // Newest history survives first, and the trim is disclosed so missing turns are not read as no evidence.
  expect(context).toContain(history[0]!.turnId)
  expect(context).not.toContain(history[2]!.turnId)
  expect(context).toContain('older feedback omitted to fit')
  // Fitting history is never trimmed.
  const short = {...packet,recentFeedback:[{turnId:crypto.randomUUID(),matches:[],taughtConceptIds:[]}]}
  expect(JSON.stringify(liveFeedbackInlineControl(short,crypto.randomUUID()))).not.toContain('omitted to fit')
})
