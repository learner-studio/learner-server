import type { DurableCallPlan } from '@learner/llm/lib/cli/durable-cli-call.js'
import { CLI_RATE_LIMITED, cliPauseMs } from '@learner/llm/lib/llm/llm-limits.js'
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { driveAttempt, pgLeaseStore } from './llm-attempt-lease.js'

/**
 * Model calls of the simulated-learner experiment. Every call is keyed (run, learner, call key): its row in
 * `learning_sim_calls` is the reservation (written before the call, so the cap counts it) and then the receipt
 * (written insert-once). The call runs under the shared attempt lease (llm-attempt-lease.ts `driveAttempt`,
 * docs/operations/restart-safety.md): a step that runs again finds the receipt; one whose worker was killed
 * mid-call waits for a live owner or takes the call over and ADOPTS the detached CLI child's finished result
 * (durable-cli-call.ts), so a finished call is never paid twice. `attempts` counts the transport invocations of
 * the call that recorded it. The transport is Learner's own LLM layer on the Codex CLI (the owner's ChatGPT
 * subscription); the suite swaps in a deterministic stub.
 */
type SimRole = 'learner' | 'notebook' | 'exam-answer' | 'exam-score' | 'agent-match' | 'agent-reply'
type SimModelChoice = { model: string; effort: string; timeoutSec: number }
type SimCallSpec = SimModelChoice & { runId: string; learnerId: string; callKey: string; role: SimRole; prompt: string; schema?: Record<string, unknown> }
type SimCallResult = { text: string; model: string; inputTokens: number | null; outputTokens: number | null }
/** `backend` decides what an orphaned call may cost (backend-cost.ts): the Codex CLI is repeat-free; the stub is not
 * a CLI and is never taken over. */
export type SimTransport = ((spec: SimCallSpec, durable?: DurableCallPlan) => Promise<SimCallResult>) & { backend: string }
type SimReceipt = { text: string; json: unknown; model: string; effort: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; attempts: number; reused: boolean }

/** OpenAI capacity, not a bug (reference_codex_cli): wait and send the same prompt again. */
const CAPACITY_FAILURE = /high demand|Reconnecting\.\.\.|capacity|overloaded|rate.?limit|429|UNAVAILABLE|503|stream disconnected/i
/** In-step backoff for capacity errors: 30 s then 60 s, three tries. A step must stay well inside pg-boss's
 * 15-minute job expiry, so longer waits belong to the workflow: the step fails and its retry delay takes over. */
const capacityDelayMs = (attempt: number) => 30_000 * 2 ** (attempt - 1)
const CAPACITY_ATTEMPTS = 3
/** A 429 (rate limit) is neither an attempt nor a paid invocation: the call waits out the pool's pause (the CLI
 * governor, enabled by the runner) and asks again, for at most this long within one step; then the step fails as a
 * capacity error and the workflow's retry delay takes over. A 429 never fails the learner by itself: its count is kept
 * on the receipt (`output.rateLimited`) for the health look. */
const RATE_LIMIT_STEP_BUDGET_MS = 10 * 60_000
const RATE_LIMIT_MIN_WAIT_MS = 5_000

class SimCallFailed extends Error {
  constructor(message: string, readonly capacity: boolean) { super(message) }
}

/** The batch's hard call cap. Set once by the runner for its run id; checked before every NEW model call (and
 * before each grading), never for a stored receipt, so a resume after the cap replays for free. It counts paid
 * invocations (`simCallsUsed`), not call keys: a parse retry, a capacity retry and a step retry each count, and a
 * reserved call in flight counts 1; a resumed step that adopts a killed child's answer counts again (an over-count, never an
 * under-count). Concurrent steps may overshoot by at most the calls in flight. */
let callCap: { runId: string; max: number } | null = null
export function setSimCallCap(cap: { runId: string; max: number } | null) { callCap = cap }
export class SimCallBudgetExhausted extends SimCallFailed {
  constructor(runId: string, used: number, max: number) { super(`call cap reached for run ${runId}: ${used} of ${max} calls used`, false) }
}
/** Paid invocations of a run: each receipt's counted invocations (a grading replicate is one), at least 1 per row. */
export async function simCallsUsed(runId: string) {
  return (await q<{ n: number }>(`SELECT COALESCE(sum(GREATEST(COALESCE((output->>'invocations')::int, attempts), 1)), 0)::int n FROM learning_sim_calls WHERE run_id=$1`, [runId])).rows[0]!.n
}
export async function assertSimCallBudget(runId: string) {
  if (!callCap || callCap.runId !== runId) return
  const used = await simCallsUsed(runId)
  if (used >= callCap.max) throw new SimCallBudgetExhausted(runId, used, callCap.max)
}

const parseJson = (text: string) => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  return JSON.parse(trimmed)
}

export async function simCall(spec: SimCallSpec, transport: SimTransport, sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): Promise<SimReceipt> {
  const key = [spec.runId, spec.learnerId, spec.callKey]
  const read = async () => (await q<{ output: { text?: string }; model: string; effort: string; input_tokens: number | null; output_tokens: number | null; duration_ms: number; attempts: number; created_at: Date }>(
    'SELECT output,model,effort,input_tokens,output_tokens,duration_ms,attempts,created_at FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key=$3', key)).rows[0]
  const receipt = (r: NonNullable<Awaited<ReturnType<typeof read>>>, reused: boolean): SimReceipt => ({ text: r.output.text!, json: spec.schema ? parseJson(r.output.text!) : null, model: r.model, effort: r.effort,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, durationMs: r.duration_ms, attempts: r.attempts, reused })
  const found = await read()
  if (found?.output.text !== undefined) return receipt(found, true)
  if (!found) {
    await assertSimCallBudget(spec.runId)
    await q(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,duration_ms,attempts,output) VALUES($1,$2,$3,$4,$5,$6,0,0,'{"pending":true}'::jsonb) ON CONFLICT DO NOTHING`,
      [...key, spec.role, spec.model, spec.effort])
  }
  const started = Date.now()
  const outcome = await driveAttempt(pgLeaseStore(), {
    key: `sim:${key.join(':')}`, backend: transport.backend, fresh: !found, reservedAt: found?.created_at ?? null,
    settled: async () => (await read())?.output.text !== undefined,
    work: (durable) => callWithRetries(spec, transport, durable, sleep, () => q(`UPDATE learning_sim_calls SET output=jsonb_set(output,'{invocations}',to_jsonb(COALESCE((output->>'invocations')::int,0)+1)) WHERE run_id=$1 AND learner_id=$2 AND call_key=$3 AND NOT output ? 'text'`, key),
      // A 429 was counted as an invocation before it was sent; it was not paid: move it to rateLimited.
      () => q(`UPDATE learning_sim_calls SET output=jsonb_set(jsonb_set(output,'{invocations}',to_jsonb(GREATEST(COALESCE((output->>'invocations')::int,1)-1,0))),'{rateLimited}',to_jsonb(COALESCE((output->>'rateLimited')::int,0)+1)) WHERE run_id=$1 AND learner_id=$2 AND call_key=$3 AND NOT output ? 'text'`, key)),
    record: async ({ result, attempts }) => {
      await q(`UPDATE learning_sim_calls SET model=$4,input_tokens=$5,output_tokens=$6,duration_ms=$7,attempts=$8,output=jsonb_build_object('text',$9::text,'invocations',COALESCE((output->>'invocations')::int,$8)) || CASE WHEN output ? 'rateLimited' THEN jsonb_build_object('rateLimited',output->'rateLimited') ELSE '{}'::jsonb END WHERE run_id=$1 AND learner_id=$2 AND call_key=$3 AND NOT output ? 'text'`,
        [...key, result.model, result.inputTokens, result.outputTokens, Date.now() - started, attempts, result.text])
    },
  })
  if (outcome.kind === 'refused') throw new SimCallFailed(`${spec.role} call ${spec.callKey}: ${outcome.reason}`, false)
  return receipt((await read())!, outcome.kind === 'settled')
}

/** One call to an answer: capacity errors back off in the step, an unparseable schema'd answer is asked once more.
 * Each transport invocation takes the durable plan's next numbered call, so a replay adopts them in order. */
async function callWithRetries(spec: SimCallSpec, transport: SimTransport, durable: DurableCallPlan, sleep: (ms: number) => Promise<void>, invoked: () => Promise<unknown>, rateLimited: () => Promise<unknown>) {
  let parseRetried = false
  const stepStarted = Date.now()
  for (let attempts = 1; ; attempts++) {
    try {
      await invoked() // counted before it is paid, so a kill mid-call still counts it
      const result = await transport(spec, durable)
      if (spec.schema) {
        try { parseJson(result.text) } catch (error) {
          if (parseRetried) throw new SimCallFailed(`unparseable JSON from ${spec.role}: ${String(error).slice(0, 200)}`, false)
          parseRetried = true
          continue
        }
      }
      return { result, attempts }
    } catch (error) {
      if (error instanceof SimCallFailed) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (CLI_RATE_LIMITED.test(message)) {
        await rateLimited()
        if (Date.now() - stepStarted >= RATE_LIMIT_STEP_BUDGET_MS) throw new SimCallFailed(`${spec.role} call ${spec.callKey}: rate limited (429) for ${Math.round((Date.now() - stepStarted) / 60_000)} min; the step retries later`, true)
        console.warn(`[sim] 429 on ${spec.callKey}: not an attempt; waiting for the pool's pause`)
        attempts-- // not an attempt: the loop's increment restores the count
        await sleep(Math.max(RATE_LIMIT_MIN_WAIT_MS, cliPauseMs()))
        continue
      }
      if (!CAPACITY_FAILURE.test(message) || attempts >= CAPACITY_ATTEMPTS) throw new SimCallFailed(`${spec.role} call ${spec.callKey} failed after ${attempts} attempt(s): ${message.slice(0, 400)}`, CAPACITY_FAILURE.test(message))
      console.warn(`[sim] capacity error on ${spec.callKey} (attempt ${attempts}/${CAPACITY_ATTEMPTS}); waiting ${capacityDelayMs(attempts) / 1000}s`)
      await sleep(capacityDelayMs(attempts))
    }
  }
}

/** The real transport: Learner's LLM layer with the backend set to the Codex CLI. */
export function codexTransport(llm: { callLLM(prompt: string, options: Record<string, unknown>): Promise<unknown> }): SimTransport {
  return Object.assign(async (spec: SimCallSpec, durable?: DurableCallPlan) => {
    let usage: { inputTokens?: number; outputTokens?: number; model?: string } = {}
    const out = await llm.callLLM(spec.prompt, {
      backend: 'codex', model: spec.model, effort: spec.effort, timeout: spec.timeoutSec, killMs: spec.timeoutSec * 1000,
      ...(spec.schema ? { outputSchema: spec.schema } : {}), ...(durable ? { durable } : {}),
      onUsage: (u: typeof usage) => { usage = u },
    })
    const text = typeof out === 'string' ? out : String((out as { content?: unknown })?.content ?? '')
    return { text, model: usage.model ?? spec.model, inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null }
  }, { backend: 'codex' })
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
  return Object.assign(async (spec: SimCallSpec) => {
    const p = spec.prompt
    const words = (s: string) => [...new Set((s.match(/\b(tessel|epoch|twin|overbear|rebraid|slack|beat|mooring|draft|becalm\w*|ballast|refit|squall)\b/gi) ?? []).map((w) => w.toLowerCase()))]
    let text: string
    if (spec.role === 'learner') {
      const last = between(p, '[Agent]:', '\n[').trim() || between(p, 'TODAY\'S TASK', 'THIS SESSION').trim()
      text = `I think the ${words(last).slice(0, 2).join(' and ') || 'pipeline'} part matters here; can you explain why?`
    } else if (spec.role === 'agent-reply' && p.includes('TEACHING BUDGET')) {
      // Batch 2: state the first sheet facts the budget allows, and ask for the first concept no sheet covered. Like the
      // pilot's agent, it also claims one more fact that it only alludes to (the channel must redact that sentence).
      const left = Number(/(\d+) of this session's budget is left/.exec(p)?.[1] ?? 0)
      const sheet = [...between(p, 'FACT SHEETS available this turn', 'To read other').matchAll(/- \[([a-z-]+-f\d+)\] ([^\n]+)/g)]
      const facts = sheet.slice(0, left), extra = left ? sheet[left] : undefined
      const shown = new Set([...between(p, 'FACT SHEETS available this turn', 'To read other').matchAll(/\((halyard-core--[a-z-]+)\):/g)].map((m) => m[1]))
      const next = [...between(p, 'Concepts: ', '.\n').matchAll(/(halyard-core--[a-z-]+) \(/g)].map((m) => m[1]!).find((id) => !shown.has(id))
      text = JSON.stringify({ reply: [...(facts.length ? facts.map((f) => f[2]) : ['Let us keep going with the task.']), ...(extra ? [`More on "${extra[2]!.split(' ').slice(0, 3).join(' ')}" later.`] : [])].join(' '),
        statedFactIds: [...facts, ...(extra ? [extra] : [])].map((f) => f[1]), lookups: next ? [next] : [] })
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
  }, { backend: 'stub' })
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
