import { describe, expect, test } from 'bun:test'
import { deriveLearningHookHealth, parseLearnerToggle, sessionFromTranscript } from './learning-hook-health.js'

const now = new Date('2026-10-21T13:00:00Z')
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000)
const A = '0de0b0b6-f65f-401e-878a-cddc41f8456b'
const B = 'cad76103-f0b8-43b4-acc7-10a97820cbf6'
const C = '01a15e94-7caf-78c0-aa56-ac0559adf6cb'
const base = { now, windowMinutes: 30, prompts: [], turns: [], toggles: [], codexActivity: [], failures: [] }

describe('parseLearnerToggle', () => {
  test('reads both CLIs\' command forms and nothing else', () => {
    expect(parseLearnerToggle('/learner-off')).toBe('off')
    expect(parseLearnerToggle('  /learner-on please')).toBe('on')
    expect(parseLearnerToggle('/prompts:learner-off')).toBe('off')
    // Codex 0.160 rejects unknown slash commands; its skill mention reaches the hook verbatim.
    expect(parseLearnerToggle('$learner-off')).toBe('off')
    expect(parseLearnerToggle('$learner-on')).toBe('on')
    expect(parseLearnerToggle('<!-- learner-toggle:on -->\nTurn it on')).toBe('on')
    expect(parseLearnerToggle('why did /learner-off not work?')).toBeNull()
    expect(parseLearnerToggle('/learner-offline')).toBeNull()
    expect(parseLearnerToggle(undefined)).toBeNull()
  })
})

describe('sessionFromTranscript', () => {
  test('top-level transcripts only; subagent and tool files are not sessions', () => {
    expect(sessionFromTranscript('claude', `-root/${B}.jsonl`)).toBe(B)
    expect(sessionFromTranscript('claude', `-root/${B}/subagents/agent-x.jsonl`)).toBeNull()
    expect(sessionFromTranscript('claude', `-root/${B}/tool-results/a.txt`)).toBeNull()
    expect(sessionFromTranscript('codex', `2026/10/21/rollout-2026-10-21T12-00-00-${C}.jsonl`)).toBe(C)
    expect(sessionFromTranscript('codex', 'session_index.jsonl')).toBeNull()
  })
})

describe('deriveLearningHookHealth', () => {
  test('a prompt with a hook turn beside it is live', () => {
    const health = deriveLearningHookHealth({ ...base, prompts: [{ sessionId: B, at: at(5) }], turns: [{ sessionId: B, at: at(5.01) }] })
    expect(health.status).toBe('ok')
    expect(health.sessions).toEqual([expect.objectContaining({ provider: 'claude', sessionId: B, state: 'live' })])
  })

  test('a prompt the hook never saw is an ERROR — the 2026-09-29..10-21 outage shape', () => {
    const health = deriveLearningHookHealth({ ...base, prompts: [{ sessionId: B, at: at(5) }], turns: [{ sessionId: B, at: at(600) }] })
    expect(health.status).toBe('error')
    expect(health.sessions[0]!.state).toBe('silent')
    expect(health.messages.join(' ')).toContain(B.slice(0, 8))
  })

  test('/learner-off is honoured: a silent session that opted out is not an error', () => {
    const health = deriveLearningHookHealth({ ...base, prompts: [{ sessionId: B, at: at(5) }], toggles: [{ sessionId: B, mode: 'off', at: at(10) }] })
    expect(health.status).toBe('ok')
    expect(health.sessions[0]!.state).toBe('off')
  })

  test('/learner-on after /learner-off re-arms detection', () => {
    const health = deriveLearningHookHealth({ ...base, prompts: [{ sessionId: B, at: at(5) }], toggles: [{ sessionId: B, mode: 'off', at: at(20) }, { sessionId: B, mode: 'on', at: at(10) }] })
    expect(health.sessions[0]!.state).toBe('silent')
  })

  test('prompts outside the window are ignored', () => {
    expect(deriveLearningHookHealth({ ...base, prompts: [{ sessionId: A, at: at(45) }] }).sessions).toEqual([])
  })

  test('an active Codex session with no hook turn ever is a WARNING (hook untrusted or unconfigured)', () => {
    const health = deriveLearningHookHealth({ ...base, codexActivity: [{ sessionId: C, at: at(3) }] })
    expect(health.status).toBe('warning')
    expect(health.sessions[0]).toEqual(expect.objectContaining({ provider: 'codex', state: 'silent' }))
    expect(health.messages.join(' ')).toContain('/hooks')
  })

  test('hook-reported failures raise status by level, newest first', () => {
    const failures = [
      { provider: 'claude' as const, sessionId: B, level: 'warning' as const, kind: 'service_delayed' as const, stage: 'packet_request', detail: 'TimeoutError', at: at(9) },
      { provider: 'claude' as const, sessionId: B, level: 'error' as const, kind: 'hook_failed' as const, stage: 'packet_handling', detail: 'ZodError', at: at(2) },
    ]
    const health = deriveLearningHookHealth({ ...base, failures })
    expect(health.status).toBe('error')
    expect(health.failures.map(f => f.kind)).toEqual(['hook_failed', 'service_delayed'])
  })
})
