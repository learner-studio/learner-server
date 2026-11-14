import type { DurableCallPlan } from '@learner/llm/lib/cli/durable-cli-call.js'
import { CLI_RATE_LIMITED, cliPauseMs, thrownMessage } from '@learner/llm/lib/llm/llm-limits.js'
import { metaDbQuery as q, type MetaPgQueryFn } from '../db-metadata/_shared.js'
import { driveAttempt, pgLeaseStore, type LeaseStore } from './llm-attempt-lease.js'

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
type SimRole = 'learner' | 'agent-match' | 'agent-reply' | 'judge'
type SimModelChoice = { model: string; effort: string; timeoutSec: number }
/** `accept`: a schema'd reply it refuses is handled like an unparseable one (asked once more, then a failure), so it is never recorded.
 * `recordFailure`: a FINAL failure (SimCallFailed.final) is written into the call's row, insert-once like a receipt, and
 * every later simCall of the key (a step retry, a resumed run) raises it again without paying (the judge, re-review C1). */
type SimCallSpec = SimModelChoice & { runId: string; learnerId: string; callKey: string; role: SimRole; prompt: string; schema?: Record<string, unknown>; accept?: (json: unknown) => boolean; recordFailure?: boolean }
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

/** `final`: no retry can change the outcome, and the outcome is KNOWN (re-review B1): the cap reached, a codex run with no
 * cap, a reply refused after its one re-ask, a claim refused (takeover budget spent). Never a dead wrapper (durable.lost,
 * an unknown outcome) or any other transport error: those throw for the step's retry, as the product grader's do. */
export class SimCallFailed extends Error {
  constructor(message: string, readonly capacity: boolean, readonly final = false) { super(message) }
}

/** The run's hard call cap: its record's `maxCalls`, pinned with every learner in learning_sim_learners at the start
 * (learning-sim-run.ts), so every process and every resume reads the same one; a codex run whose record has none pays
 * no call (review 10 B1, S1: never a cap from argv or memory, never an uncapped real run). Checked before every NEW model call (and
 * before each grading) and, since review 7 S3, before every further paid invocation of a pending call (a parse,
 * capacity or step retry, or a restarted learner's replay), never for a stored receipt, so a resume after the cap
 * replays for free. It counts paid invocations (`simCallsUsed`), not call keys: each retry counts, a 429 does not (it
 * moves to `rateLimited`), and a reserved call in flight counts 1; a resumed step that adopts a killed child's answer
 * counts again (an over-count, never an under-count). Concurrent steps may overshoot by at most the calls in flight
 * (each check reads the count, then pays). */
export class SimCallBudgetExhausted extends SimCallFailed {
  constructor(runId: string, used: number, max: number) { super(`call cap reached for run ${runId}: ${used} of ${max} calls used`, false, true) }
}
/** Paid invocations of a run: each receipt's counted invocations (a grading replicate is one), at least 1 per row. */
export async function simCallsUsed(runId: string, query: typeof q = q) {
  return (await query<{ n: number }>(`SELECT COALESCE(sum(GREATEST(COALESCE((output->>'invocations')::int, attempts), 1)), 0)::int n FROM learning_sim_calls WHERE run_id=$1`, [runId])).rows[0]!.n
}
/** `more`: invocations about to be paid beyond those counted (0 for a new key: its reservation will count the first). */
export async function assertSimCallBudget(runId: string, more = 0, query: typeof q = q) {
  const cap = (await query<{ max: number | null; codex: boolean | null }>(`SELECT max((config->'run'->>'maxCalls')::int) AS max, bool_or(config->>'transport'='codex') AS codex
    FROM learning_sim_learners WHERE run_id=$1`, [runId])).rows[0]
  if (cap?.max == null) {
    if (cap?.codex) throw new SimCallFailed(`run ${runId} has no call cap in its record; a codex call is never paid uncapped`, false, true)
    return
  }
  const used = await simCallsUsed(runId, query)
  if (more ? used + more > cap.max : used >= cap.max) throw new SimCallBudgetExhausted(runId, used, cap.max)
}

const parseJson = (text: string) => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  return JSON.parse(trimmed)
}

/** `deps`: the table and the leases, Postgres unless a unit test passes fakes. */
export async function simCall(spec: SimCallSpec, transport: SimTransport, sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  { query = q, leases = pgLeaseStore(query) }: { query?: MetaPgQueryFn; leases?: LeaseStore } = {}): Promise<SimReceipt> {
  const key = [spec.runId, spec.learnerId, spec.callKey]
  const read = async () => (await query<{ output: { text?: string; invocations?: number; failed?: string }; model: string; effort: string; input_tokens: number | null; output_tokens: number | null; duration_ms: number; attempts: number; created_at: Date }>(
    'SELECT output,model,effort,input_tokens,output_tokens,duration_ms,attempts,created_at FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key=$3', key)).rows[0]
  const receipt = (r: NonNullable<Awaited<ReturnType<typeof read>>>, reused: boolean): SimReceipt => ({ text: r.output.text!, json: spec.schema ? parseJson(r.output.text!) : null, model: r.model, effort: r.effort,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, durationMs: r.duration_ms, attempts: r.attempts, reused })
  const stored = (r: NonNullable<Awaited<ReturnType<typeof read>>>, reused: boolean) => {
    if (r.output.failed !== undefined) throw new SimCallFailed(r.output.failed, false, true)
    return receipt(r, reused)
  }
  // Insert-once, like the receipt: only while the row holds neither. If another owner recorded a receipt meanwhile
  // (review 3 N1), that receipt is the call's outcome, so the step's output and the row agree.
  const fail = async (error: unknown): Promise<SimReceipt> => {
    if (spec.recordFailure && error instanceof SimCallFailed && error.final) {
      await query(`UPDATE learning_sim_calls SET output=(output - 'pending') || jsonb_build_object('failed',$4::text) WHERE run_id=$1 AND learner_id=$2 AND call_key=$3 AND NOT output ? 'text' AND NOT output ? 'failed'`, [...key, error.message])
      const now = await read()
      if (now?.output.text !== undefined) return receipt(now, true)
    }
    throw error
  }
  const found = await read()
  if (found?.output.text !== undefined || found?.output.failed !== undefined) return stored(found, true)
  if (!found) {
    await assertSimCallBudget(spec.runId, 0, query)
    await query(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,duration_ms,attempts,output) VALUES($1,$2,$3,$4,$5,$6,0,0,'{"pending":true}'::jsonb) ON CONFLICT DO NOTHING`,
      [...key, spec.role, spec.model, spec.effort])
  }
  const started = Date.now()
  let outcome: Awaited<ReturnType<typeof driveAttempt<Awaited<ReturnType<typeof callWithRetries>>>>>
  try { outcome = await driveAttempt(leases, {
    key: `sim:${key.join(':')}`, backend: transport.backend, fresh: !found, reservedAt: found?.created_at ?? null,
    settled: async () => { const r = await read(); return r?.output.text !== undefined || r?.output.failed !== undefined },
    work: (durable) => callWithRetries(spec, transport, durable, sleep, async () => {
      // A further paid invocation of this key (its reservation counts the first) is checked against the cap first.
      if (Number((await read())?.output?.invocations ?? 0) >= 1) await assertSimCallBudget(spec.runId, 1, query)
      await query(`UPDATE learning_sim_calls SET output=jsonb_set(output,'{invocations}',to_jsonb(COALESCE((output->>'invocations')::int,0)+1)) WHERE run_id=$1 AND learner_id=$2 AND call_key=$3 AND NOT output ? 'text'`, key)
    },
      // A 429 was counted as an invocation before it was sent; it was not paid: move it to rateLimited.
      () => query(`UPDATE learning_sim_calls SET output=jsonb_set(jsonb_set(output,'{invocations}',to_jsonb(GREATEST(COALESCE((output->>'invocations')::int,1)-1,0))),'{rateLimited}',to_jsonb(COALESCE((output->>'rateLimited')::int,0)+1)) WHERE run_id=$1 AND learner_id=$2 AND call_key=$3 AND NOT output ? 'text'`, key)),
    record: async ({ result, attempts }) => {
      await query(`UPDATE learning_sim_calls SET model=$4,input_tokens=$5,output_tokens=$6,duration_ms=$7,attempts=$8,output=jsonb_build_object('text',$9::text,'invocations',COALESCE((output->>'invocations')::int,$8)) || CASE WHEN output ? 'rateLimited' THEN jsonb_build_object('rateLimited',output->'rateLimited') ELSE '{}'::jsonb END WHERE run_id=$1 AND learner_id=$2 AND call_key=$3 AND NOT output ? 'text' AND NOT output ? 'failed'`,
        [...key, result.model, result.inputTokens, result.outputTokens, Date.now() - started, attempts, result.text])
    },
  }) } catch (error) { return fail(error) }
  if (outcome.kind === 'refused') return fail(new SimCallFailed(`${spec.role} call ${spec.callKey}: ${outcome.reason}`, false, true))
  return stored((await read())!, outcome.kind === 'settled')
}

/** One call to an answer: capacity errors back off in the step, an unparseable schema'd answer is asked once more.
 * Each transport invocation takes the durable plan's next numbered call, so a replay adopts them in order. */
export async function callWithRetries(spec: SimCallSpec, transport: SimTransport, durable: DurableCallPlan, sleep: (ms: number) => Promise<void>, invoked: () => Promise<unknown>, rateLimited: () => Promise<unknown>) {
  let parseRetried = false
  const stepStarted = Date.now()
  for (let attempts = 1; ; attempts++) {
    try {
      await invoked() // counted before it is paid, so a kill mid-call still counts it
      const result = await transport(spec, durable)
      if (spec.schema) {
        try { if (spec.accept && !spec.accept(parseJson(result.text))) throw new Error(`reply refused: ${result.text.slice(0, 100)}`) } catch (error) {
          if (parseRetried) throw new SimCallFailed(`unparseable or refused JSON from ${spec.role}: ${String(error).slice(0, 200)}`, false, true)
          parseRetried = true
          continue
        }
      }
      return { result, attempts }
    } catch (error) {
      // A wrapper that died in this step left an unknown outcome: nothing after it is final (re-review B1).
      if (error instanceof SimCallFailed) throw error.final && durable.lost ? new SimCallFailed(error.message, error.capacity, false) : error
      const message = thrownMessage(error)
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
 * and learns in the crudest possible way (the learner repeats Halyard words the agent used). It proves the loop is wired, never an effect.
 */
export function stubTransport(): SimTransport {
  return Object.assign(async (spec: SimCallSpec) => {
    const p = spec.prompt
    const words = (s: string) => [...new Set((s.match(/\b(tessel|epoch|twin|overbear|rebraid|slack|beat|mooring|draft|becalm\w*|ballast|refit|squall)\b/gi) ?? []).map((w) => w.toLowerCase()))]
    let text: string
    if (spec.role === 'learner') {
      const last = between(p, '[Agent]:', '\n[').trim() || between(p, 'TODAY\'S TASK', 'THIS SESSION').trim()
      text = `I think the ${words(last).slice(0, 2).join(' and ') || 'pipeline'} part matters here; can you explain why?`
    } else if (spec.role === 'judge') {
      // The blind judge: "yes" when the text holds at least half of the fact's longer words.
      const long = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)
      const fact = long(between(p, 'FACT:\n<<<\n', '\n>>>')), said = new Set(long(between(p, 'TEXT:\n<<<\n', '\n>>>')))
      text = JSON.stringify({ states: fact.filter((w) => said.has(w)).length * 2 >= fact.length ? 'yes' : 'no' })
    } else if (spec.role === 'agent-reply' && p.includes('TEACHING BUDGET')) {
      // Batch 2: state the first sheet facts the budget allows, the last of them as a loose paraphrase (half its words
      // after its concept's title: a claim the matcher misses and the channel verifies), then, like the pilot's agent,
      // claim two more: one stated verbatim beyond the budget, one only alluded to (the channel must redact both).
      // With 3 or more facts it leaves the first unclaimed (the matcher still finds it: path `matched`).
      const left = Number(/(\d+) of this session's budget is left/.exec(p)?.[1] ?? 0)
      const offered = between(p, 'FACT SHEETS available this turn', 'TASK BRIEF').split('\n\n').flatMap((block) => {
        const title = /^(?:[^\n]*\n)?([^\n(]+) \(halyard-core--[a-z-]+\):/.exec(block)?.[1]?.trim() ?? ''
        return [...block.matchAll(/- \[([a-z-]+-f\d+)\] ([^\n]+)/g)].map((m) => ({ id: m[1]!, fact: m[2]!, title }))
      })
      // The anchor arm's TEACHING PLAN, when the prompt carries one, is followed: its facts first, in its order.
      const plan = [...between(p, 'TEACHING PLAN', '\n\n').matchAll(/^- ([a-z-]+-f\d+): /gm)].map((m) => m[1]!)
      const sheet = [...plan.flatMap((id) => offered.filter((f) => f.id === id)), ...offered.filter((f) => !plan.includes(f.id))]
      const facts = sheet.slice(0, left), over = left ? sheet[left] : undefined, alluded = left ? sheet[left + 1] : undefined
      const loose = (f: (typeof sheet)[number]) => `${f.title}: ${f.fact.replace(/[.]$/, '').split(' ').filter((_, k) => k % 2 === 0).join(' ')}.`
      text = JSON.stringify({ reply: [...(facts.length ? facts.map((f, k) => k === facts.length - 1 && k > 0 ? loose(f) : f.fact) : ['Let us keep going with the task.']),
        ...(over ? [over.fact] : []), ...(alluded ? [`More on "${alluded.fact.split(' ').slice(0, 3).join(' ')}" later.`] : [])].join(' '),
      statedFactIds: [...facts.slice(facts.length > 2 ? 1 : 0), ...(over ? [over] : []), ...(alluded ? [alluded] : [])].map((f) => f.id) })
    } else if (spec.role === 'agent-reply') {
      const msg = between(p, 'SAM\'S MESSAGE:\n', '\nWrite your reply').trim()
      text = `About ${words(msg).join(', ') || 'this'}: a rebraid uses epoch + 1, and a twin with the same epoch is dropped.`
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
