import { readFile, appendFile, mkdir, writeFile, unlink, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  LearningHookContextInput, LearningHookContextOutput, claudeLearningContext, liveFeedbackInlineControl, liveCatalogContexts,
  LearningFeedbackBeginPacket, learningNativeHookOutput, parseLearnerToggle, RecordLearningHookHealthInput, RpcError, type RpcName,
} from '@learner/contract'
import { cachedCatalog, storeCatalog } from './catalog.js'
import { learner, loadConfig, paths } from './config.js'
import { deferLearningTurn, resumeLearningTurn, isTransientLearningFailure } from './recovery.js'

/**
 * The Claude/Codex native hook: a thin transport onto the Learner server.
 * Validation, storage and policy live in the server; this file only moves
 * hook events to RPCs and RPC answers back into hook output.
 *
 *   index.ts [--provider codex]            hook event on stdin -> hook output on stdout
 *   index.ts --catalog-part <n>             one inline catalog part (companion hook)
 *   index.ts --submit                       feedback JSON on stdin -> guidance JSON
 *   index.ts --catalog                      print the live concept catalog
 *
 * Every top-level Claude/Codex session is enabled; `/learner-off` and
 * `/learner-on` toggle one session.
 */
const Event = z.object({ hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']), session_id: z.string().uuid(), prompt: z.string().optional(), prompt_id: z.string().uuid().optional(), agent_id: z.string().optional(), tool_use_id: z.string().optional() })
const traceDir = paths.traceDir
const provider: 'claude' | 'codex' = process.argv.includes('--provider') && process.argv[process.argv.indexOf('--provider') + 1] === 'codex' ? 'codex' : 'claude'
// Codex has no user slash commands; its toggles are the `$learner-…` skills.
const resumeCommand = provider === 'codex' ? '$learner-on' : '/learner-on'
const offPath = (sessionId: string) => `${traceDir}/${sessionId}.off`
const isOff = (sessionId: string) => readFile(offPath(sessionId), 'utf8').then(() => true, () => false)

async function postLearning(name: RpcName, data: unknown, timeoutMs: number) {
  // Responses are validated by the callers that use them; telemetry answers are not.
  return (await learner())(name, data as never, { timeoutMs, validate: false }) as Promise<unknown>
}

type HealthEvent = Omit<z.input<typeof RecordLearningHookHealthInput>, 'provider' | 'occurredAt'>
/** Report to the app; when it is unreachable, keep the report for the next lifecycle flush. */
async function reportHealth(event: HealthEvent) {
  const payload = { ...event, provider, occurredAt: new Date().toISOString() }
  try { await postLearning('recordLearningHookHealth', payload, 700) }
  catch { try { await mkdir(traceDir, { recursive: true, mode: 0o700 }); await writeFile(`${traceDir}/${event.sessionId}.${crypto.randomUUID()}.health.pending`, JSON.stringify(payload), { mode: 0o600 }) } catch { /* best effort */ } }
}
/** Shown to the human in both CLIs; the model never sees it. */
const warn = (text: string, output: Record<string, unknown> = {}) => ({ ...output, systemMessage: `⚠ Learner: ${text}` })
const catalogAckPath = (sessionId: string) => `${traceDir}/${sessionId}.catalog.json`
const traceSnapshotPath = (sessionId: string, turnId: string) => `${traceDir}/${sessionId}.${turnId}.prompt.json`
const deferredTurnPath = (sessionId: string, turnId: string) => `${traceDir}/${sessionId}.${turnId}.begin.json`
const TraceSnapshot = z.object({ sessionId: z.string(), turnId: z.string().uuid(), promptRevision: z.literal('task-teaching-v2'), outcomeVersion: z.enum(['v1', 'v1.2', 'v1.3', 'v1.4']).optional(), catalogVersion: z.string(), promptHash: z.string(), injectedPrompt: z.string(), message: z.string() })

async function recordObservedTrace(snapshot: z.infer<typeof TraceSnapshot>, phase: 'injection' | 'submission', extra: { feedback?: unknown; guidance?: unknown } = {}, defer = false) {
  try {
    const path = `${traceSnapshotPath(snapshot.sessionId, snapshot.turnId)}.${phase}.pending`
    const recorded = path.replace(/\.pending$/, '.recorded')
    if (await readFile(recorded, 'utf8').then(() => true).catch(() => false)) return
    const prior = await readFile(path, 'utf8').catch(() => null)
    const observed = prior ? JSON.parse(prior) : { ...snapshot, phase, ...extra }
    // Local handoff survives API downtime; retries send these exact observed bytes.
    await writeFile(path, JSON.stringify(observed), { mode: 0o600 })
    // Claude's native hook has a hard deadline. Analytics must never consume the
    // remaining delivery budget; the lifecycle outbox replay exports it.
    if (defer) return
    try { await postLearning('recordLearningFeedbackTrace', observed, 1000); await writeFile(recorded, 'recorded', { mode: 0o600 }); await unlink(path) }
    catch {
      await appendFile(`${traceDir}/${snapshot.sessionId}.jsonl`, JSON.stringify({ at: new Date().toISOString(), event: 'TelemetryPending', turnId: snapshot.turnId, phase }) + '\n', { mode: 0o600 })
    }
  } catch { /* Telemetry disk failures must not suppress teaching or a saved submission. */ }
}

/**
 * Replay a few outboxed calls. Health reports go first: the app's silent-hook
 * cross-check only knows a session is OFF from its `session_disabled` report,
 * so a stranded one turns every later prompt into a false "hook never recorded".
 * An off session replays health reports only (its toggle state), nothing else.
 */
async function flushPendingTraces(sessionId: string, { healthOnly = false } = {}) {
  const files = (await readdir(traceDir).catch(() => [] as string[]))
    .filter((name) => name.startsWith(`${sessionId}.`) && (healthOnly ? name.endsWith('.health.pending') : name.endsWith('.pending')))
    .sort((a, b) => Number(b.endsWith('.health.pending')) - Number(a.endsWith('.health.pending')))
    .slice(0, 2)
  for (const name of files) {
    try {
      await postLearning(name.endsWith('.archive.pending') ? 'notifyLearningTranscriptChanged' : name.endsWith('.health.pending') ? 'recordLearningHookHealth' : 'recordLearningFeedbackTrace', JSON.parse(await readFile(`${traceDir}/${name}`, 'utf8')), 300)
      if (!name.endsWith('.archive.pending') && !name.endsWith('.health.pending')) await writeFile(`${traceDir}/${name.replace(/\.pending$/, '.recorded')}`, 'recorded', { mode: 0o600 })
      await unlink(`${traceDir}/${name}`)
    } catch { /* Keep exact bytes for the next lifecycle signal. */ }
  }
}

async function notifyArchive(sessionId: string, invocationId: string, timeoutMs: number) {
  const pending = `${traceDir}/${sessionId}.${invocationId}.archive.pending`
  const payload = { sessionId, invocationId }
  // Persist before HTTP, so an API timeout can retry the same notification ID.
  try { await mkdir(traceDir, { recursive: true, mode: 0o700 }); await writeFile(pending, JSON.stringify(payload), { mode: 0o600 }) } catch { /* still try the server */ }
  const result = await postLearning('notifyLearningTranscriptChanged', payload, timeoutMs)
  await unlink(pending).catch(() => undefined)
  return result
}

/** `--submit`: provisional feedback for a turn the control hook began. */
export async function submitLearningFeedback(raw: unknown) {
  const config = await loadConfig()
  const identity = z.object({ sessionId: z.string().uuid(), turnId: z.string().uuid(), catalogVersion: z.string() }).parse(raw)
  const { sessionId } = identity
  if (!config.liveFeedback || await isOff(sessionId)) throw new Error(`Learning feedback is off for this session (${resumeCommand} to resume)`)
  await resumeLearningTurn(deferredTurnPath(identity.sessionId, identity.turnId), identity, (name, data) => postLearning(name, data, 15000))
  const result = await postLearning('submitLearningTurnFeedback', raw, 15000)
  const parsed = z.object({ status: z.literal('provisional'), replayed: z.boolean(), guidance: LearningHookContextOutput }).parse(result)
  try {
    await mkdir(traceDir, { recursive: true, mode: 0o700 })
    await writeFile(catalogAckPath(sessionId), JSON.stringify({ catalogVersion: identity.catalogVersion }), { mode: 0o600 })
    await appendFile(`${traceDir}/${sessionId}.jsonl`, JSON.stringify({ at: new Date().toISOString(), event: 'FeedbackSubmitted', turnId: identity.turnId, replayed: parsed.replayed, guidance: parsed.guidance }) + '\n', { mode: 0o600 })
    const snapshot = await readFile(traceSnapshotPath(sessionId, identity.turnId), 'utf8').then((text) => TraceSnapshot.parse(JSON.parse(text))).catch(() => null)
    if (snapshot) await recordObservedTrace(snapshot, 'submission', { feedback: raw, guidance: parsed.guidance })
  } catch { /* Feedback is already durable; a local trace failure is not a submission failure. */ }
  return parsed
}

/** Native hook transport only; all Learning policy stays inside the authenticated server. */
export async function runLearningHook(raw: unknown, catalogPart?: number) {
  const event = Event.safeParse(raw)
  if (!event.success) return {}
  const config = await loadConfig()
  // Subagents are excluded: their "prompts" are the parent's delegation, not the learner's words.
  if (event.data.agent_id) return {}
  const sessionId = event.data.session_id
  const toggle = event.data.hook_event_name === 'UserPromptSubmit' ? parseLearnerToggle(event.data.prompt) : null
  if (toggle) {
    // Catalog companions run concurrently with the control hook; only the control hook toggles.
    if (catalogPart !== undefined) return {}
    await mkdir(traceDir, { recursive: true, mode: 0o700 })
    if (toggle === 'off') await writeFile(offPath(sessionId), new Date().toISOString(), { mode: 0o600 })
    else { await unlink(offPath(sessionId)).catch(() => undefined); await unlink(catalogAckPath(sessionId)).catch(() => undefined) }
    await reportHealth({ sessionId, level: 'info', kind: toggle === 'off' ? 'session_disabled' : 'session_enabled' })
    const state = toggle === 'off' ? `OFF — no Learning context or feedback until ${resumeCommand}` : 'ON — full Learning context and feedback resume from the next message'
    return { systemMessage: `Learner ${state} (this session only).`, ...learningNativeHookOutput(provider, `LEARNER ${toggle.toUpperCase()}: the user switched Learning ${state} for this session only. Confirm in one short line and do nothing else for this message.`) }
  }
  if (await isOff(sessionId)) {
    // The off toggle may have been reported during an outage; keep retrying it, or the app calls this session silent.
    if (catalogPart === undefined) await flushPendingTraces(sessionId, { healthOnly: true })
    return {}
  }
  // Catalog companions are read-only: they never begin turns, notify the archive
  // or call the server. Only the control hook owns those effects.
  if (catalogPart !== undefined) {
    if (!config.liveFeedback || event.data.hook_event_name !== 'UserPromptSubmit') return {}
    if (!Number.isSafeInteger(catalogPart) || catalogPart < 0) return {}
    const catalog = await cachedCatalog()
    if (!catalog) return {}
    const ack = await readFile(catalogAckPath(sessionId), 'utf8').then(JSON.parse).catch(() => null)
    if (ack?.catalogVersion === catalog.catalogVersion) return {}
    const context = liveCatalogContexts(catalog.catalog, catalog.catalogVersion)[catalogPart]
    if (context) {
      try {
        await mkdir(traceDir, { recursive: true, mode: 0o700 })
        await appendFile(`${traceDir}/${sessionId}.jsonl`, JSON.stringify({ at: new Date().toISOString(), event: 'CatalogPartEmitted', deliveryRevision: 'inline-parts-v1', catalogVersion: catalog.catalogVersion, part: catalogPart, characters: context.length, sha256: createHash('sha256').update(context).digest('hex') }) + '\n', { mode: 0o600 })
      } catch { /* Emission telemetry is not a delivery acknowledgement. */ }
    }
    return learningNativeHookOutput(provider, context ?? '')
  }
  if (event.data.hook_event_name === 'SessionStart') {
    // Claude emits SessionStart after compaction/resume too. Reload on the next
    // human turn; the catalog is not acknowledged until a successful submission.
    await unlink(catalogAckPath(sessionId)).catch(() => undefined)
    return {}
  }
  const started = Date.now()
  const invocationId = crypto.randomUUID()
  const requestId = invocationId
  const promptId = event.data.prompt_id ?? null
  const messageFingerprint = createHash('sha256').update(JSON.stringify([event.data.session_id, event.data.hook_event_name, event.data.prompt ?? null, event.data.tool_use_id ?? null])).digest('hex')
  let response: unknown
  let archiveRunId: string | null = null
  let archiveAccepted = false
  let outcome = 'fail_open'
  let failure: { stage: string; kind: string; status?: number } | undefined
  try {
    const post = (name: RpcName, data: unknown) => postLearning(name, data, config.timeoutMs)
    const acknowledged = await readFile(catalogAckPath(sessionId), 'utf8')
      .then((value) => z.object({ catalogVersion: z.string() }).parse(JSON.parse(value)).catalogVersion).catch(() => undefined)
    let deferred = false
    const beginInput = { message: event.data.prompt, sessionId, turnId: invocationId, foundationFirst: config.foundationFirst, catalogVersion: acknowledged }
    const [, lookup] = await Promise.all([
      // The archive locates Claude transcripts by session id; Codex rollouts are found by the archive scan.
      (provider === 'claude' ? notifyArchive(sessionId, invocationId, config.timeoutMs) : Promise.reject(new Error('Codex archive is scan-driven')))
        .then((value) => { archiveRunId = z.object({ runId: z.string().uuid().nullable() }).parse(value).runId; archiveAccepted = true }).catch(() => undefined),
      event.data.hook_event_name === 'UserPromptSubmit'
        ? Promise.resolve().then(() => config.liveFeedback
          ? post('beginLearningFeedbackTurn', beginInput)
          : post('getLearningHookContext', LearningHookContextInput.parse({ message: event.data.prompt, sessionId, requestId, foundationFirst: config.foundationFirst }))).catch(async (error) => {
            const status = error instanceof RpcError ? error.status : undefined
            failure = { stage: 'packet_request', kind: error instanceof Error ? error.name : 'UnknownError', ...(status ? { status } : {}) }
            if (config.liveFeedback && isTransientLearningFailure(error)) {
              // Deferral needs a catalog to hand the model; without a cached one there is nothing safe to say.
              const catalog = await cachedCatalog()
              if (!catalog) return null
              await mkdir(traceDir, { recursive: true, mode: 0o700 })
              const packet = await deferLearningTurn(deferredTurnPath(sessionId, invocationId), beginInput, catalog)
              deferred = true
              return packet
            }
            return null
          })
        : Promise.resolve(null),
    ])
    if (event.data.hook_event_name !== 'UserPromptSubmit') { await flushPendingTraces(sessionId); outcome = archiveAccepted ? 'archive_queued' : 'fail_open'; return {} }
    if (config.liveFeedback) {
      const packet = LearningFeedbackBeginPacket.parse(lookup)
      if (packet.turnId !== invocationId) throw new Error('Mismatched Learning turn')
      response = { turnId: packet.turnId, catalogVersion: packet.catalogVersion, catalogCount: packet.catalog?.length ?? 0, deliveryRevision: 'inline-parts-v1', catalogParts: packet.catalog ? liveCatalogContexts(packet.catalog, packet.catalogVersion).length : 0 }
      outcome = deferred ? 'feedback_deferred' : 'feedback_requested'
      // The companions emit the cached catalog; keep it on the version the server just named.
      if (packet.catalog) await storeCatalog({ catalogVersion: packet.catalogVersion, catalog: packet.catalog }).catch(() => undefined)
      else if ((await cachedCatalog())?.catalogVersion !== packet.catalogVersion) await ensureCatalogVersion(packet.catalogVersion, config.timeoutMs)
      const envelope = liveFeedbackInlineControl(packet, sessionId)
      if (deferred && 'hookSpecificOutput' in envelope && envelope.hookSpecificOutput) {
        envelope.hookSpecificOutput.additionalContext += '\n\nLEARNING SERVICE DELAYED: this turn is saved locally for initialization, not yet confirmed in the database. Recent service history was not fetched. The --submit transport will initialize this exact turn before submitting and return fresh guidance. Do not interpret missing history as no prior understanding. If the service remains unavailable, disclose that feedback was not saved and continue the task.'
      }
      // Archive the entire planned model-facing bundle, not just the control string.
      const controlText = 'hookSpecificOutput' in envelope ? envelope.hookSpecificOutput!.additionalContext : ''
      const injectedPrompt = [controlText, ...(packet.catalog ? liveCatalogContexts(packet.catalog, packet.catalogVersion) : [])].join('\n\n')
      const snapshot = TraceSnapshot.parse({ sessionId, turnId: invocationId, promptRevision: 'task-teaching-v2', outcomeVersion: 'v1.4', catalogVersion: packet.catalogVersion,
        promptHash: createHash('sha256').update(injectedPrompt).digest('hex'), injectedPrompt, message: event.data.prompt })
      try {
        await mkdir(traceDir, { recursive: true, mode: 0o700 })
        await writeFile(traceSnapshotPath(sessionId, invocationId), JSON.stringify(snapshot), { mode: 0o600 })
        await recordObservedTrace(snapshot, 'injection', {}, true)
      } catch { /* Never suppress the model's teaching context for a local telemetry failure. */ }
      if (!deferred) return envelope
      await reportHealth({ sessionId, level: 'warning', kind: 'service_delayed', stage: failure?.stage, detail: failure?.kind, status: failure?.status })
      return warn('service unreachable — this turn is saved locally and will sync; feedback history was not loaded.', envelope)
    }
    const packet = LearningHookContextOutput.parse(lookup)
    if (packet.requestId !== requestId || packet.foundationFirst !== config.foundationFirst) throw new Error('Mismatched Learning response')
    response = packet
    outcome = packet.decision
    return claudeLearningContext(packet)
  } catch (error) {
    failure ??= { stage: 'packet_handling', kind: error instanceof Error ? error.name : 'UnknownError' }
    const detail = `${failure.kind}${failure.status ? ` HTTP ${failure.status}` : ''}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`
    await reportHealth({ sessionId, level: 'error', kind: 'hook_failed', stage: failure.stage, detail, status: failure.status })
    return warn(`hook failed at ${failure.stage} (${failure.kind}) — this turn has NO Learning context. Reported to the Learning app.`)
  } finally {
    // Local private diagnostics only; never delay or break the turn on trace failure.
    try {
      await mkdir(traceDir, { recursive: true, mode: 0o700 })
      await appendFile(`${traceDir}/${sessionId}.jsonl`, JSON.stringify({ at: new Date().toISOString(), startedAt: new Date(started).toISOString(), sessionId, invocationId, promptId, requestId, messageFingerprint, event: event.data.hook_event_name,
        durationMs: Date.now() - started, outcome, archiveRunId, response: response ?? null, failure }) + '\n', { mode: 0o600 })
    } catch { /* The hook always fails open. */ }
  }
}

/** The server moved to a catalog this hook has not cached (it already acknowledged it elsewhere): fetch it. */
async function ensureCatalogVersion(version: string, timeoutMs: number) {
  try {
    const fresh = await (await learner())('getLearningFeedbackCatalog', {}, { timeoutMs })
    if (fresh.catalogVersion === version) await storeCatalog(fresh)
  } catch { /* Companions stay silent; the control text already tells the model to use --catalog. */ }
}

if (import.meta.main) {
  try {
    if (process.argv.includes('--catalog')) {
      const config = await loadConfig().catch(() => ({ timeoutMs: 5000 }))
      const catalog = await (await learner())('getLearningFeedbackCatalog', {}, { timeoutMs: Math.max(config.timeoutMs, 5000) })
      await storeCatalog(catalog).catch(() => undefined)
      process.stdout.write(JSON.stringify(catalog))
      process.exit(0)
    }
    const raw = JSON.parse(await Bun.stdin.text())
    const partIndex = process.argv.indexOf('--catalog-part')
    process.stdout.write(JSON.stringify(process.argv.includes('--submit') ? await submitLearningFeedback(raw) : await runLearningHook(raw, partIndex < 0 ? undefined : Number(process.argv[partIndex + 1]))))
  } catch (error) {
    if (process.argv.includes('--submit') || process.argv.includes('--catalog')) { process.stderr.write(error instanceof Error ? error.message : 'Learning submission failed'); process.exitCode = 1 }
    // Config, stdin or import failure: nothing reached the model, so say so instead of failing open silently.
    else process.stdout.write(JSON.stringify(warn(`hook crashed (${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}) — this turn has NO Learning context.`)))
  }
}
