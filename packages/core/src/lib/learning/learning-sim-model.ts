import { metaDbQuery as q } from '../db-metadata/_shared.js'

/**
 * Model calls of the simulated-learner experiment. Every call is keyed (run, learner, call key) and its result
 * is written once to `learning_sim_calls`: a step that runs again (a resumed workflow, a re-started run with the
 * same runId) finds the receipt and never pays twice. The transport is Learner's own LLM layer on the Codex CLI
 * (the owner's ChatGPT subscription); the suite swaps in a deterministic stub.
 */
export type SimRole = 'learner' | 'notebook' | 'exam-answer' | 'exam-score' | 'agent-match' | 'agent-reply'
export type SimModelChoice = { model: string; effort: string; timeoutSec: number }
export type SimCallSpec = SimModelChoice & { runId: string; learnerId: string; callKey: string; role: SimRole; prompt: string; schema?: Record<string, unknown> }
export type SimCallResult = { text: string; model: string; inputTokens: number | null; outputTokens: number | null }
export type SimTransport = (spec: SimCallSpec) => Promise<SimCallResult>
export type SimReceipt = { text: string; json: unknown; model: string; effort: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; attempts: number; reused: boolean }

/** OpenAI capacity, not a bug (reference_codex_cli): wait and send the same prompt again. */
export const CAPACITY_FAILURE = /high demand|Reconnecting\.\.\.|capacity|overloaded|rate.?limit|429|UNAVAILABLE|503|stream disconnected/i
/** In-step backoff for capacity errors: 30 s then 60 s, three tries. A step must stay well inside pg-boss's
 * 15-minute job expiry, so longer waits belong to the workflow: the step fails and its retry delay takes over. */
export const capacityDelayMs = (attempt: number) => 30_000 * 2 ** (attempt - 1)
export const CAPACITY_ATTEMPTS = 3

export class SimCallFailed extends Error {
  constructor(message: string, readonly capacity: boolean) { super(message) }
}

/** The batch's hard call cap. Set once by the runner for its run id; checked before every NEW model call (and
 * before each grading), never for a stored receipt, so a resume after the cap replays for free. Concurrent steps
 * may overshoot by at most the number of calls in flight. */
let callCap: { runId: string; max: number } | null = null
export function setSimCallCap(cap: { runId: string; max: number } | null) { callCap = cap }
export class SimCallBudgetExhausted extends SimCallFailed {
  constructor(runId: string, used: number, max: number) { super(`call cap reached for run ${runId}: ${used} of ${max} calls used`, false) }
}
export async function assertSimCallBudget(runId: string) {
  if (!callCap || callCap.runId !== runId) return
  const used = (await q<{ n: number }>('SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1', [runId])).rows[0]!.n
  if (used >= callCap.max) throw new SimCallBudgetExhausted(runId, used, callCap.max)
}

const parseJson = (text: string) => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  return JSON.parse(trimmed)
}

export async function simCall(spec: SimCallSpec, transport: SimTransport, sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): Promise<SimReceipt> {
  const read = async () => (await q<{ output: { text: string }; model: string; effort: string; input_tokens: number | null; output_tokens: number | null; duration_ms: number; attempts: number }>(
    'SELECT output,model,effort,input_tokens,output_tokens,duration_ms,attempts FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key=$3', [spec.runId, spec.learnerId, spec.callKey])).rows[0]
  const done = await read()
  if (done) return { text: done.output.text, json: spec.schema ? parseJson(done.output.text) : null, model: done.model, effort: done.effort, inputTokens: done.input_tokens, outputTokens: done.output_tokens, durationMs: done.duration_ms, attempts: done.attempts, reused: true }
  await assertSimCallBudget(spec.runId)
  const started = Date.now()
  let attempts = 0
  let lastError = ''
  let parseRetried = false
  for (;;) {
    attempts++
    try {
      const result = await transport(spec)
      // A schema'd answer that does not parse is retried once with the same prompt; then it is a failure.
      let json: unknown = null
      if (spec.schema) {
        try { json = parseJson(result.text) } catch (error) {
          if (parseRetried) throw new SimCallFailed(`unparseable JSON from ${spec.role}: ${String(error).slice(0, 200)}`, false)
          parseRetried = true
          continue
        }
      }
      const durationMs = Date.now() - started
      await q(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,input_tokens,output_tokens,duration_ms,attempts,output)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT DO NOTHING`,
      [spec.runId, spec.learnerId, spec.callKey, spec.role, result.model, spec.effort, result.inputTokens, result.outputTokens, durationMs, attempts, JSON.stringify({ text: result.text })])
      // A concurrent duplicate of this step may have written first: the stored receipt is the answer.
      const stored = (await read())!
      return { text: stored.output.text, json: spec.schema ? parseJson(stored.output.text) : json, model: stored.model, effort: stored.effort, inputTokens: stored.input_tokens, outputTokens: stored.output_tokens, durationMs: stored.duration_ms, attempts: stored.attempts, reused: false }
    } catch (error) {
      if (error instanceof SimCallFailed) throw error
      lastError = error instanceof Error ? error.message : String(error)
      if (!CAPACITY_FAILURE.test(lastError) || attempts >= CAPACITY_ATTEMPTS) throw new SimCallFailed(`${spec.role} call ${spec.callKey} failed after ${attempts} attempt(s): ${lastError.slice(0, 400)}`, CAPACITY_FAILURE.test(lastError))
      console.warn(`[sim] capacity error on ${spec.callKey} (attempt ${attempts}/${CAPACITY_ATTEMPTS}); waiting ${capacityDelayMs(attempts) / 1000}s`)
      await sleep(capacityDelayMs(attempts))
    }
  }
}

/** The real transport: Learner's LLM layer with the backend set to the Codex CLI. */
export function codexTransport(llm: { callLLM(prompt: string, options: Record<string, unknown>): Promise<unknown> }): SimTransport {
  return async (spec) => {
    let usage: { inputTokens?: number; outputTokens?: number; model?: string } = {}
    const out = await llm.callLLM(spec.prompt, {
      backend: 'codex', model: spec.model, effort: spec.effort, timeout: spec.timeoutSec, killMs: spec.timeoutSec * 1000,
      ...(spec.schema ? { outputSchema: spec.schema } : {}),
      onUsage: (u: typeof usage) => { usage = u },
    })
    const text = typeof out === 'string' ? out : String((out as { content?: unknown })?.content ?? '')
    return { text, model: usage.model ?? spec.model, inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null }
  }
}

// ---------------------------------------------------------------- stub (the suite)

const between = (text: string, start: string, end: string) => {
  const i = text.indexOf(start)
  if (i < 0) return ''
  const j = text.indexOf(end, i + start.length)
  return text.slice(i + start.length, j < 0 ? undefined : j)
}

/**
 * A deterministic stand-in for the model, for the suite: answers every role in the shape the real one does,
 * and learns in the crudest possible way (the learner repeats Halyard words the agent used; the exam answer
 * copies notebook lines that name the concept). It proves the loop is wired, never an effect.
 */
export function stubTransport(): SimTransport {
  return async (spec) => {
    const p = spec.prompt
    const words = (s: string) => [...new Set((s.match(/\b(tessel|epoch|twin|overbear|rebraid|slack|beat|mooring|draft|becalm\w*|ballast|refit|squall)\b/gi) ?? []).map((w) => w.toLowerCase()))]
    let text: string
    if (spec.role === 'learner') {
      const last = between(p, '[Agent]:', '\n[').trim() || between(p, 'TODAY\'S TASK', 'CONVERSATION').trim()
      text = `I think the ${words(last).slice(0, 2).join(' and ') || 'pipeline'} part matters here; can you explain why?`
    } else if (spec.role === 'agent-reply' && p.includes('TEACHING BUDGET')) {
      // Batch 2: state the first sheet facts the budget allows, and ask for the first concept no sheet covered.
      const left = Number(/(\d+) of this session's budget is left/.exec(p)?.[1] ?? 0)
      const facts = [...between(p, 'FACT SHEETS available this turn', 'To read other').matchAll(/- \[([a-z-]+-f\d+)\] ([^\n]+)/g)].slice(0, left)
      const shown = new Set([...between(p, 'FACT SHEETS available this turn', 'To read other').matchAll(/\((halyard-core--[a-z-]+)\):/g)].map((m) => m[1]))
      const next = [...between(p, 'Concepts: ', '.\n').matchAll(/(halyard-core--[a-z-]+) \(/g)].map((m) => m[1]!).find((id) => !shown.has(id))
      text = JSON.stringify({ reply: facts.length ? facts.map((f) => f[2]).join(' ') : 'Let us keep going with the task.', statedFactIds: facts.map((f) => f[1]), lookups: next ? [next] : [] })
    } else if (spec.role === 'agent-reply') {
      const msg = between(p, 'SAM\'S MESSAGE:\n', '\nWrite your reply').trim()
      text = `About ${words(msg).join(', ') || 'this'}: a rebraid uses epoch + 1, and a twin with the same epoch is dropped.`
    } else if (spec.role === 'notebook') {
      // The agent's sentences that name a Halyard word, then the bare words: capacity decides how many are kept.
      const conv = between(p, 'TODAY\'S CONVERSATION:\n', '\nCURRENT NOTEBOOK')
      const sentences = [...conv.matchAll(/\[Agent\]: ([^\n]+)/g)].flatMap((m) => m[1]!.split(/(?<=\.)\s+/)).map((x) => x.trim()).filter((x) => words(x).length)
      text = JSON.stringify({ entries: [{ topic: 'session notes', facts: [...new Set(sentences)] }, { topic: 'session terms', facts: words(conv).map((w) => `Halyard has a ${w}.`) }, { topic: 'rebraid', facts: ['Rebraid = epoch + 1; twins are dropped.'] }] })
    } else if (spec.role === 'exam-answer') {
      const questions = JSON.parse(between(p, 'QUESTIONS:\n', '\nReturn')) as Array<{ id: string; question: string }>
      const notebook = between(p, 'NOTEBOOK:\n', '\nQUESTIONS').toLowerCase()
      const guessField = p.includes('set guess') ? { guess: false } : {}
      text = JSON.stringify({ answers: questions.map((item) => ({ ...guessField, id: item.id, answer: words(item.question).some((w) => notebook.includes(w)) ? `From my notes: ${notebook.slice(0, 80)}` : "I don't know" })) })
    } else if (spec.role === 'exam-score') {
      const items = JSON.parse(between(p, 'ITEMS:\n', '\nReturn')) as Array<{ id: string; answer: string }>
      text = JSON.stringify({ scores: items.map((item) => ({ id: item.id, points: /don't know/i.test(item.answer) ? 0 : 1, note: 'stub' })) })
    } else {
      // agent-match: one task_context tag on the first catalog concept whose title word the message contains.
      const message = between(p, 'CURRENT DEVELOPER MESSAGE:\n<<<\n', '\n>>>')
      const catalog = (between(p, 'CATALOG IDS:', '\n').trim() || '').split(',').filter(Boolean)
      const hit = catalog.find((id) => message.toLowerCase().includes(id.split('--')[1]!.split('-')[0]!))
      text = JSON.stringify({ matches: hit ? [{ conceptId: hit, quote: message.slice(0, 20), relationship: 'task_context', outcome: 'not_assessed', reason: 'stub', remainingGap: null }] : [], taughtConceptIds: [] })
    }
    return { text, model: `stub-${spec.model}`, inputTokens: Math.ceil(p.length / 4), outputTokens: Math.ceil(text.length / 4) }
  }
}

/** A stub grader LLM for LearningConceptAssessmentService: one proposal per concept citing the first human source. */
export const stubGraderLlm = {
  async callLLMWithStructuredOutput(params: { prompt: string; parseFn: (value: unknown) => unknown; callOptions?: { onUsage?: (u: Record<string, unknown>) => void } }) {
    const input = JSON.parse(params.prompt.slice(params.prompt.lastIndexOf('INPUT:\n') + 'INPUT:\n'.length)) as { nodeStates: Array<{ conceptId: string }>; evidence: Array<{ id: string; role: string; text: string }> }
    const human = input.evidence.find((e) => e.role === 'user' && e.text.trim())
    const proposals = input.nodeStates.map((s) => ({ conceptId: s.conceptId, understandingPercent: human ? Math.min(100, 5 * Math.min(20, input.evidence.filter((e) => e.role === 'user').length * 2)) : null,
      confidence: human ? 'medium' : 'insufficient', demonstrated: human ? [{ description: 'stub', sourceId: human.id, quote: human.text.slice(0, 20) }] : [], gaps: [], nextCheck: 'stub', needsReview: true }))
    params.callOptions?.onUsage?.({ inputTokens: Math.ceil(params.prompt.length / 4), outputTokens: 200 })
    return params.parseFn(JSON.stringify({ proposals }))
  },
}
