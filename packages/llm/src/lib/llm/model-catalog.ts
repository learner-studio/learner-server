/**
 * The master model catalogue — one exported, typed, Zod-validated answer to
 * "which (backend, model, effort) combinations can this app actually run".
 *
 * Why this exists at all: before it, "what models do we have" was answered by
 * `MODELS` in llm-service.ts, which is a ROLE table (`EXTRACTOR`,
 * `INTELLIGENCE`, `WEB_SEARCH`) — it says which model does a job, never which
 * models exist. So every new surface that wanted to offer a choice had to
 * re-derive the list, and nothing anywhere recorded which combinations the
 * account can actually run.
 *
 * Three properties are load-bearing:
 *
 * 1. **It records what is HONORED, not what is passed.** Two backends used to
 *    accept a caller's choice and silently substitute their own: the claude
 *    branch of `_getCliMapping` returned `model: 'opus'` unconditionally, and
 *    the agy branch pinned `reasoning: 'high'` at both mapping layers while
 *    still emitting `--effort`. A catalogue that listed the passed value would
 *    have documented a lie. Those two mappings are now fixed (see
 *    `llm-service.ts::_getCliMapping` and `cli-agents.ts::AGY_REASONING_MAP`),
 *    and `resolveHonoredSelection` below is the one function that says what a
 *    selection becomes on the wire.
 *
 * 2. **Effort sets are PER MODEL, not per backend.** `gemini-3.1-pro` ships
 *    only low and high; `gpt-5.6-sol` adds `ultra` that no other family has;
 *    `claude-sonnet-4-6` on agy has its effort baked into the slug and accepts
 *    no variant at all. A backend-wide effort list would offer choices that
 *    fail at spawn time.
 *
 * 3. **Availability rots, so every status carries a probe date.** A model the
 *    operator's plan covered in September can 403 in October. `works` means
 *    "a real one-line prompt came back through the real callLLM path on
 *    `probedAt`", nothing stronger.
 *
 * Model names are enumerated from the CLIs themselves, never guessed:
 *   - codex  — `/root/.codex/models_cache.json` (slug + supported_reasoning_levels)
 *   - claude — `claude --help` (`--model` aliases, `--effort` levels)
 *   - agy    — `agy models` (slug + display name), `agy --help` (`--effort`)
 */

import { z } from 'zod'

/** CLI backends this app can route an LLM call to. */
export const llmBackendSchema = z.enum(['codex', 'claude', 'agy'])
export type LlmBackend = z.infer<typeof llmBackendSchema>

/**
 * The canonical reasoning vocabulary this app speaks internally, mirroring
 * `REASONING_LEVELS` in llm-service.ts. Callers may use any of these; the
 * catalogue maps them onto whatever the chosen model actually accepts.
 */
export const reasoningLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
])
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>

/**
 * Effort values a CLI accepts on the wire. `ultra` is codex-only and exists on
 * only two families (Sol, Terra); asking for it anywhere else clamps down to
 * that model's ceiling.
 */
export const cliEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export type CliEffort = z.infer<typeof cliEffortSchema>

/**
 * What a probe found.
 *
 * - `works`                — a real one-line prompt returned text on `probedAt`.
 * - `fails`                — the call errored; `reason` carries the class.
 * - `untested-same-class`  — not probed, because a sibling effort on the SAME
 *                            model was probed and effort is a flag rather than
 *                            a different entitlement. Probing every level of
 *                            every model burns real quota for no new
 *                            information.
 * - `unprobed`             — never attempted.
 */
export const modelProbeStatusSchema = z.enum([
  'works',
  'fails',
  'untested-same-class',
  'unprobed',
])
export type ModelProbeStatus = z.infer<typeof modelProbeStatusSchema>

export const modelEffortSchema = z.object({
  effort: cliEffortSchema,
  status: modelProbeStatusSchema,
  /** Failure class when `status` is `fails`; null otherwise. */
  reason: z.string().nullable(),
  /** ISO date the status was established, or null when never probed. */
  probedAt: z.string().nullable(),
})
export type ModelEffort = z.infer<typeof modelEffortSchema>

export const modelCatalogEntrySchema = z.object({
  backend: llmBackendSchema,
  /**
   * The id callers pass as `model` and the UI persists. For agy this is the
   * FAMILY (`gemini-3.7-flash`), not a suffixed slug — see `effortInSlug`.
   */
  id: z.string().min(1),
  label: z.string().min(1),
  efforts: z.array(modelEffortSchema).min(1),
  defaultEffort: cliEffortSchema,
  /**
   * When true the backend encodes effort in the model slug itself
   * (`gemini-3.7-flash` + `high` -> `gemini-3.7-flash-high`) rather than in a
   * separate flag. Only agy does this.
   */
  effortInSlug: z.boolean(),
  /**
   * Tokens of corpus ONE extraction prompt may carry on this model — the batch
   * size every extractor is tuned with. See `resolveExtractorInputBudgetChars`
   * for how it becomes a character budget and which override beats it.
   */
  inputBudgetTokens: z.number().int().positive(),
  notes: z.string().nullable(),
})
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>

/**
 * The date the probe sweep behind the `works`/`fails` statuses ran. A status
 * older than a few weeks should be re-probed rather than trusted — plan
 * entitlements and model availability both move.
 */
export const MODEL_CATALOG_PROBED_AT = '2026-09-01'

const probed = (
  effort: CliEffort,
  status: ModelProbeStatus,
  reason: string | null = null,
): ModelEffort => ({
  effort,
  status,
  reason,
  probedAt: status === 'unprobed' ? null : MODEL_CATALOG_PROBED_AT,
})

// ── Per-model input budgets ──────────────────────────────────────────────────
//
// How many tokens of corpus ONE extraction prompt may carry — the batch size
// every extractor (events windows, blog/jobs/news/product/marketing single
// prompts) is tuned with. Three families, three provenances:
//
//   - CODEX: measured. The codex CLI stalls (120s SIGKILL, nice.com/products)
//     rather than refuses when a prompt merely approaches its 1,048,576-char
//     cap; 240k chars — the events-window shape that succeeded on every site
//     whose single-prompt runs failed — is the one value known to hit neither
//     wall. 60k tokens × 4 chars/token reproduces it exactly, so codex
//     behaviour is unchanged by the move to tokens.
//   - AGY (Gemini): MEASURED 2026-09-07 against the agy CLI (stream-json
//     stdin, exactly as `cli-agents.ts` drives it). Two marker probes — 40
//     markers at 20k chars over 800k, then 80 at 4k over 320k — asked for the
//     largest marker seen: the model answered 10 and 48, i.e. ~192-200k chars
//     (49-56k input tokens) reach it and the REST IS DROPPED SILENTLY, no
//     error, no stderr. A 946k-char jobs prompt therefore reported 71.9k
//     input tokens on three runs and never saw the pages appended at its end.
//     The operator's earlier setting (400k tokens, "the batch size we tune
//     all extractor models with") is the model's capability, not the CLI's;
//     until the CLI path is fixed, 45k tokens (180k chars) keeps every prompt
//     under the measured cliff with headroom for the CLI's own preamble.
//     Raise it only after re-running the marker probe.
//   - CLAUDE: a conservative, unmeasured placeholder — half of the 200k-token
//     context window, leaving room for the CLI's own system prompt and the
//     structured response. Raise it only against an observation.
export const CODEX_INPUT_BUDGET_TOKENS = 60_000
/**
 * Operator decision 2026-09-07: GPT-5.6 Luna is the extractor default at
 * HIGH effort and its payload throttle is 400k tokens — the batch size all
 * extractor models are tuned with. NOTE this is a TOKEN budget; the codex CLI
 * still refuses a prompt over `BACKEND_INPUT_CAP_CHARS.codex` characters, so
 * `resolveExtractorInputBudgetChars` clamps the character budget under that
 * cap (see `EXTRACTOR_PROMPT_HEADROOM_CHARS.codex`). Raising the cap is a CLI
 * change, not a catalogue one.
 */
export const LUNA_INPUT_BUDGET_TOKENS = 400_000
export const AGY_INPUT_BUDGET_TOKENS = 45_000
export const CLAUDE_INPUT_BUDGET_TOKENS = 100_000

/**
 * Every (backend, model, effort) combination the three CLIs name.
 *
 * Hidden codex models (`gpt-reserve`, `codex-auto-review`, both
 * `visibility: "hide"` in the models cache) are deliberately omitted — they
 * are internal routing targets, not selectable models.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  // ---- codex -------------------------------------------------------------
  {
    backend: 'codex',
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    defaultEffort: 'low',
    effortInSlug: false,
    inputBudgetTokens: CODEX_INPUT_BUDGET_TOKENS,
    notes: 'Frontier agentic model; the app-wide INTELLIGENCE default.',
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'untested-same-class'),
      probed('max', 'untested-same-class'),
      probed('ultra', 'works'),
    ],
  },
  {
    backend: 'codex',
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CODEX_INPUT_BUDGET_TOKENS,
    notes: null,
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'untested-same-class'),
      probed('max', 'untested-same-class'),
      probed('ultra', 'works'),
    ],
  },
  {
    backend: 'codex',
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CODEX_INPUT_BUDGET_TOKENS,
    notes:
      'Codex\'s most capable model. Added 2026-09-10 for curriculum concept generation, which is an '
      + 'authoring task over a small prompt (one lane of an approved outline) rather than an extraction '
      + 'over a large one, so the extractor default (Luna, tuned for a 400k-token payload) is the wrong '
      + 'trade. Budget left at the ordinary codex figure deliberately: the concept call\'s input is the '
      + 'outline, never a crawl corpus. Efforts are transcribed from '
      + '/root/.codex/models_cache.json (low|medium|high|xhigh|max|ultra); only `high` is exercised here.',
    efforts: [
      probed('low', 'untested-same-class'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class', 'curriculum concept + prerequisite default, 2026-09-10'),
      probed('xhigh', 'untested-same-class'),
      probed('max', 'untested-same-class'),
      probed('ultra', 'untested-same-class'),
    ],
  },
  {
    backend: 'codex',
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: LUNA_INPUT_BUDGET_TOKENS,
    notes: 'Extractor default since 2026-09-07 (high). 400k-token payload throttle, clamped in characters under the codex CLI cap.',
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'works', 'extractor default 2026-09-07; marker probe on stdin — see codex-cap-probe results in the crawl report'),
      probed('xhigh', 'untested-same-class'),
      probed('max', 'works'),
    ],
  },
  {
    backend: 'codex',
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CODEX_INPUT_BUDGET_TOKENS,
    notes: null,
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'works'),
    ],
  },
  {
    backend: 'codex',
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CODEX_INPUT_BUDGET_TOKENS,
    notes: null,
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'works'),
    ],
  },
  {
    backend: 'codex',
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CODEX_INPUT_BUDGET_TOKENS,
    notes: 'The extraction workhorse (MODELS.EXTRACTOR).',
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'works'),
    ],
  },
  {
    backend: 'codex',
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    defaultEffort: 'high',
    effortInSlug: false,
    inputBudgetTokens: CODEX_INPUT_BUDGET_TOKENS,
    notes:
      'The models cache reports supported_in_api: false, but it answers through the CLI — probed, works.',
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'works'),
    ],
  },

  // ---- claude ------------------------------------------------------------
  {
    backend: 'claude',
    id: 'opus',
    label: 'Claude Opus',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CLAUDE_INPUT_BUDGET_TOKENS,
    notes: 'The admin-CLI default.',
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'untested-same-class'),
      probed('max', 'works'),
    ],
  },
  {
    backend: 'claude',
    id: 'sonnet',
    label: 'Claude Sonnet',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CLAUDE_INPUT_BUDGET_TOKENS,
    notes: null,
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'untested-same-class'),
      probed('max', 'works'),
    ],
  },
  {
    backend: 'claude',
    id: 'haiku',
    label: 'Claude Haiku',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CLAUDE_INPUT_BUDGET_TOKENS,
    notes: null,
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'untested-same-class'),
      probed('max', 'works'),
    ],
  },
  {
    backend: 'claude',
    id: 'fable',
    label: 'Claude Fable',
    defaultEffort: 'medium',
    effortInSlug: false,
    inputBudgetTokens: CLAUDE_INPUT_BUDGET_TOKENS,
    notes: null,
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'untested-same-class'),
      probed('xhigh', 'untested-same-class'),
      probed('max', 'works'),
    ],
  },

  // ---- agy (Antigravity) -------------------------------------------------
  // Effort is part of the slug for the gemini families; the three borrowed
  // models below carry a fixed effort in their own name and accept no variant.
  {
    backend: 'agy',
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    defaultEffort: 'medium',
    effortInSlug: true,
    inputBudgetTokens: AGY_INPUT_BUDGET_TOKENS,
    notes: 'Extractor default since 2026-09-07. Medium probed with the four marker payloads (200k/400k/800k/1.6M chars): identical ~200k-char stdin cap as 3.7 (49/49/25/13 markers seen), exit 0, empty stderr.',
    efforts: [
      {effort:'low',status:'unprobed',probedAt:null,reason:null},
      probed('medium', 'works', 'marker probe 2026-09-07: same ~200k-char cap as 3.7-flash-medium'),
      {effort:'high',status:'unprobed',probedAt:null,reason:null},
    ],
  },
  {
    backend: 'agy',
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    defaultEffort: 'high',
    effortInSlug: true,
    inputBudgetTokens: AGY_INPUT_BUDGET_TOKENS,
    notes: 'The web-search workhorse (MODELS.WEB_SEARCH).',
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'works'),
    ],
  },
  {
    backend: 'agy',
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    defaultEffort: 'high',
    effortInSlug: true,
    inputBudgetTokens: AGY_INPUT_BUDGET_TOKENS,
    notes: null,
    efforts: [
      probed('low', 'works'),
      probed('medium', 'untested-same-class'),
      probed('high', 'works'),
    ],
  },
  {
    backend: 'agy',
    id: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    defaultEffort: 'high',
    effortInSlug: true,
    inputBudgetTokens: AGY_INPUT_BUDGET_TOKENS,
    notes: 'Only low and high exist — `agy models` lists no medium variant.',
    efforts: [probed('low', 'works'), probed('high', 'works')],
  },
  {
    backend: 'agy',
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6 (Antigravity)',
    defaultEffort: 'high',
    effortInSlug: false,
    inputBudgetTokens: CLAUDE_INPUT_BUDGET_TOKENS,
    notes: 'Thinking is fixed in the slug; agy exposes no effort variant.',
    efforts: [probed('high', 'fails', 'agy CLI returned empty output')],
  },
  {
    backend: 'agy',
    id: 'claude-opus-4-6-thinking',
    label: 'Claude Opus 4.6 (Antigravity)',
    defaultEffort: 'high',
    effortInSlug: false,
    inputBudgetTokens: CLAUDE_INPUT_BUDGET_TOKENS,
    notes: 'Thinking is fixed in the slug; agy exposes no effort variant.',
    efforts: [probed('high', 'fails', 'agy CLI returned empty output')],
  },
  {
    backend: 'agy',
    id: 'gpt-oss-120b-medium',
    label: 'GPT-OSS 120B (Antigravity)',
    defaultEffort: 'medium',
    effortInSlug: false,
    // A 128k-context open-weights model; the codex-sized budget is the safe fit.
    inputBudgetTokens: CODEX_INPUT_BUDGET_TOKENS,
    notes: 'Effort is fixed in the slug; agy exposes no variant.',
    efforts: [probed('medium', 'works')],
  },
]

/**
 * Collapse a canonical reasoning level onto the efforts a model actually
 * offers. `off`/`minimal` mean "as little as this model will do" and
 * `xhigh`/`max` mean "as much as it will do", so both ends clamp rather than
 * fail — a caller asking for `off` on a model whose floor is `medium` gets
 * `medium`, which is the honest answer.
 */
export function resolveEffortForModel(
  entry: ModelCatalogEntry,
  level: ReasoningLevel,
): CliEffort {
  const offered = entry.efforts.map((e) => e.effort)
  const exact = offered.find((e) => e === level)
  if (exact) return exact
  const ladder: readonly CliEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const wantedIndex = level === 'off' || level === 'minimal' ? 0 : ladder.indexOf(level as CliEffort)
  const byDistance = [...offered].sort(
    (a, b) => Math.abs(ladder.indexOf(a) - wantedIndex) - Math.abs(ladder.indexOf(b) - wantedIndex),
  )
  return byDistance[0] ?? entry.defaultEffort
}

/** Capability-aware application discovery. CLI callers retain their typed text-only view. */
export const modelCapabilitySchema=z.enum(['text-generation','typed-decision','noul','choice','score'])
export type ModelCapability=z.infer<typeof modelCapabilitySchema>
export const appModelSelectionSchema=z.object({provider:z.enum(['codex','claude','agy','typesafe']),model:z.string().min(1),effort:cliEffortSchema.optional()})
export type AppModelSelection=z.infer<typeof appModelSelectionSchema>
export const capabilityModelSchema=z.object({provider:appModelSelectionSchema.shape.provider,id:z.string(),label:z.string(),capabilities:z.array(modelCapabilitySchema),efforts:z.array(cliEffortSchema),probe:z.object({status:modelProbeStatusSchema,probedAt:z.string().nullable(),provenance:z.string()}),limits:z.object({statePlusLongestQuestionTokens:z.number(),totalInputTokens:z.number()}).optional()})
export type CapabilityModel=z.infer<typeof capabilityModelSchema>
export const DEFAULT_DECISION_SELECTION:AppModelSelection=Object.freeze({provider:'typesafe',model:'jev-1.13.0'})
const JEV_CATALOG_ENTRY:CapabilityModel={provider:'typesafe',id:DEFAULT_DECISION_SELECTION.model,label:'Jev 1.13.0',capabilities:['typed-decision','noul','choice','score'],efforts:[],probe:{status:'works',probedAt:'2026-09-24',provenance:'Official HTTP minimal key probe and six full-664-concept Noul calls; run 480d0df3-7127-45df-b1c8-9dee8b333347. Choice/score documented and unit-validated, not live-probed.'},limits:{statePlusLongestQuestionTokens:32000,totalInputTokens:64000}}
export function listCapabilityModels(capability?:ModelCapability):CapabilityModel[]{
 const entries:CapabilityModel[]=[...MODEL_CATALOG.map(e=>({provider:e.backend,id:e.id,label:e.label,capabilities:['text-generation' as const],efforts:e.efforts.map(e=>e.effort),probe:{status:(e.efforts.some(x=>x.status==='works')?'works':e.efforts.every(x=>x.status==='fails')?'fails':'unprobed') as ModelProbeStatus,probedAt:MODEL_CATALOG_PROBED_AT,provenance:'Existing CLI model/effort probe catalog'}})),JEV_CATALOG_ENTRY]
 return entries.filter(e=>!capability||e.capabilities.includes(capability))
}
export function resolveModelCapability(value:unknown,capability:ModelCapability):{selection:AppModelSelection;entry:CapabilityModel}{
 const selection=appModelSelectionSchema.strict().parse(value),entry=listCapabilityModels().find(e=>e.provider===selection.provider&&e.id===selection.model)
 if(!entry||!entry.capabilities.includes(capability))throw new Error(`Model does not support ${capability}`)
 if(selection.effort&&!entry.efforts.includes(selection.effort))throw new Error('Model does not support requested effort')
 if(entry.probe.status==='fails')throw new Error('Model unavailable at last probe')
 return {selection,entry}
}

export function listCatalogEntries(backend?: LlmBackend): readonly ModelCatalogEntry[] {
  return backend ? MODEL_CATALOG.filter((e) => e.backend === backend) : MODEL_CATALOG
}

export function findCatalogEntry(
  backend: LlmBackend,
  modelId: string,
): ModelCatalogEntry | null {
  const wanted = String(modelId).trim().toLowerCase()
  return (
    MODEL_CATALOG.find((e) => e.backend === backend && e.id.toLowerCase() === wanted) ?? null
  )
}

/**
 * Find the catalogue entry for a model id WITHOUT knowing its backend — used
 * by the CLI mapping, which is handed a bare model string. For agy, a
 * caller-supplied suffixed slug (`gemini-3.7-flash-high`) resolves to its
 * family entry and the suffix is returned as the honored effort, because
 * naming a suffixed slug is a more specific request than a generic level.
 */
export function matchCatalogEntry(
  modelId: unknown,
): { entry: ModelCatalogEntry; slugEffort: CliEffort | null } | null {
  const wanted = String(modelId ?? '').trim().toLowerCase()
  if (!wanted) return null
  const direct = MODEL_CATALOG.find((e) => e.id.toLowerCase() === wanted)
  if (direct) return { entry: direct, slugEffort: null }
  for (const entry of MODEL_CATALOG) {
    if (!entry.effortInSlug) continue
    const prefix = `${entry.id.toLowerCase()}-`
    if (!wanted.startsWith(prefix)) continue
    const suffix = wanted.slice(prefix.length)
    const match = entry.efforts.find((e) => e.effort === suffix)
    if (match) return { entry, slugEffort: match.effort }
  }
  return null
}

/**
 * What a selection actually becomes on the wire: the model string the CLI
 * receives and the effort value it is given. This is the function that makes
 * the catalogue's "honored, not passed" promise checkable.
 */
export function resolveHonoredSelection(
  entry: ModelCatalogEntry,
  level: ReasoningLevel | CliEffort,
  slugEffort: CliEffort | null = null,
): { model: string; effort: CliEffort } {
  const effort =
    slugEffort ?? resolveEffortForModel(entry, level as ReasoningLevel)
  return {
    model: entry.effortInSlug ? `${entry.id}-${effort}` : entry.id,
    effort,
  }
}

/** True when the catalogue's last probe found this pairing usable. */
export function isSelectableCombination(
  backend: LlmBackend,
  modelId: string,
  effort: CliEffort,
): boolean {
  const entry = findCatalogEntry(backend, modelId)
  if (!entry) return false
  const found = entry.efforts.find((e) => e.effort === effort)
  return !!found && found.status !== 'fails'
}

/**
 * Refuse a combination the backend cannot honour, rather than letting a UI
 * offer a choice that is silently substituted downstream. Both known
 * silent-substitution bugs (claude discarding the model, agy discarding the
 * effort) are fixed in the mapping — this guard is what keeps a THIRD one from
 * shipping unnoticed.
 */
export function assertSelectableCombination(
  backend: LlmBackend,
  modelId: string,
  effort: CliEffort,
): void {
  const entry = findCatalogEntry(backend, modelId)
  if (!entry) {
    throw new Error(
      `Unknown model "${modelId}" for backend "${backend}". Known: ${listCatalogEntries(backend)
        .map((e) => e.id)
        .join(', ')}`,
    )
  }
  const found = entry.efforts.find((e) => e.effort === effort)
  if (!found) {
    throw new Error(
      `Model "${modelId}" does not offer effort "${effort}". Offered: ${entry.efforts
        .map((e) => e.effort)
        .join(', ')}`,
    )
  }
  if (found.status === 'fails') {
    throw new Error(
      `Model "${modelId}" at effort "${effort}" was last probed on ${found.probedAt} and failed: ${found.reason}`,
    )
  }
}

// ── Prompt input caps ─────────────────────────────────────────────────────────

/**
 * The hard character cap a backend's CLI enforces on ONE prompt, before any
 * tokenization. Measured from the codex CLI's own refusal, which names it:
 *
 *   turn/start failed: Input exceeds the maximum length of 1048576 characters.
 *   {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1501573}
 *
 * codex's value is measured from its refusal; agy's is measured from the
 * marker probe above (2026-09-07): it does not refuse, it silently keeps the
 * first ~192k chars. claude carries codex's number as a placeholder — no
 * refusal observed. Nothing enforces the cap against a budgeted prompt, so the
 * budgets above must stay under these.
 */
export const BACKEND_INPUT_CAP_CHARS: Readonly<Record<LlmBackend, number>> = Object.freeze({
  codex: 1_048_576,
  claude: 1_048_576,
  agy: 192_000,
})

/**
 * The single ratio this app uses to turn a token budget into the character
 * budget the windowing/bounding helpers actually enforce. Every CLI takes
 * characters and tokenizes behind the flag, so the budget has to be applied in
 * characters; 4 chars/token is the customary English-prose estimate and errs
 * toward SMALLER prompts for markdown-heavy corpora (URLs and punctuation
 * tokenize denser than prose), which is the safe direction.
 */
export const EXTRACTOR_CHARS_PER_TOKEN = 4

/**
 * Budget used when the extractor model is not in the catalogue (an operator
 * pointed `EXTRACTOR_MODEL` at something unlisted). Per backend, and the most
 * conservative member of each family, so an unknown model is never handed a
 * prompt bigger than its siblings are known to take.
 */
export const BACKEND_INPUT_BUDGET_TOKENS: Readonly<Record<LlmBackend, number>> = Object.freeze({
  codex: CODEX_INPUT_BUDGET_TOKENS,
  claude: CLAUDE_INPUT_BUDGET_TOKENS,
  agy: AGY_INPUT_BUDGET_TOKENS,
})

/**
 * Parse an `EXTRACTOR_INPUT_BUDGET_TOKENS`-style override. Empty/absent means
 * "no override"; anything else must be a positive integer, and a malformed
 * value throws rather than silently falling back — a typo in `.env` must not
 * quietly revert extraction to a different batch size.
 */
export function parseInputBudgetTokensOverride(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const tokens = Number(text)
  if (!Number.isInteger(tokens) || tokens <= 0) {
    throw new Error(
      `EXTRACTOR_INPUT_BUDGET_TOKENS must be a positive integer token count; got "${text}"`,
    )
  }
  return tokens
}

/**
 * A workflow step asking for its budget: the extraction type (jobs, events,
 * …) plus the two step-level throttles. `overrideTokens` is the per-step env
 * override (`EXTRACTOR_INPUT_BUDGET_TOKENS_<TYPE>`); `inputBudgetTokens` is
 * the value the extraction-type registry entry declares. Both are optional
 * and the registry entry normally declares none, in which case the provider
 * level (env `EXTRACTOR_INPUT_BUDGET_TOKENS`, then the catalogue entry)
 * decides.
 */
export interface ExtractorInputBudgetStep {
  readonly type: string
  readonly inputBudgetTokens?: number | null
  readonly overrideTokens?: unknown
}

export interface ExtractorInputBudgetArgs {
  readonly backend: LlmBackend | string
  readonly model: string
  /** The provider-level env override, `EXTRACTOR_INPUT_BUDGET_TOKENS`. */
  readonly overrideTokens?: unknown
  readonly step?: ExtractorInputBudgetStep | null
}

/**
 * Tokens of corpus ONE extraction prompt may carry, most specific wins:
 *
 *   1. workflow step, env:      `EXTRACTOR_INPUT_BUDGET_TOKENS_<TYPE>`
 *   2. workflow step, registry: `ExtractionTypeEntry.inputBudgetTokens`
 *   3. provider, env:           `EXTRACTOR_INPUT_BUDGET_TOKENS`
 *   4. provider, catalogue:     the (backend, model) entry's `inputBudgetTokens`
 *   5. backend default:         for a model the catalogue does not list
 *
 * agy accepts a suffixed slug (`gemini-3.7-flash-medium`) because that is what
 * the wire receives.
 */
export function resolveExtractorInputBudgetTokens(args: ExtractorInputBudgetArgs): number {
  const stepEnv = parseInputBudgetTokensOverride(args.step?.overrideTokens)
  if (stepEnv !== null) return stepEnv
  if (args.step?.inputBudgetTokens != null) {
    const tokens = args.step.inputBudgetTokens
    if (!Number.isInteger(tokens) || tokens <= 0) {
      throw new Error(`Extraction step "${args.step.type}" declares a non-positive input budget (${String(tokens)})`)
    }
    return tokens
  }
  const override = parseInputBudgetTokensOverride(args.overrideTokens)
  if (override !== null) return override
  const backend = llmBackendSchema.safeParse(String(args.backend).trim().toLowerCase())
  if (!backend.success) {
    throw new Error(`Cannot resolve an input budget for unknown backend "${args.backend}"`)
  }
  const matched = matchCatalogEntry(args.model)
  if (matched && matched.entry.backend === backend.data) return matched.entry.inputBudgetTokens
  return BACKEND_INPUT_BUDGET_TOKENS[backend.data]
}

/**
 * The same budget in characters — what `partitionCorpusWindows` and
 * `boundCorpusToBudget` enforce. THE one number every extractor window and
 * single-prompt corpus is sized by; nothing downstream should carry its own
 * character constant (the sole exception is the output-bound
 * `EXHAUSTIVE_LIST_WINDOW_CHARS` roster window in corpus-pages.ts).
 */
export function resolveExtractorInputBudgetChars(args: ExtractorInputBudgetArgs): number {
  const chars = resolveExtractorInputBudgetTokens(args) * EXTRACTOR_CHARS_PER_TOKEN
  const backend = llmBackendSchema.safeParse(String(args.backend).trim().toLowerCase())
  const cap = backend.success
    ? backendInputCapChars(backend.data) - EXTRACTOR_PROMPT_HEADROOM_CHARS[backend.data]
    : Infinity
  return Math.min(chars, cap)
}

/**
 * Characters held back from a backend's hard cap when a token budget converts
 * to more characters than the CLI accepts (400k tokens × 4 = 1.6M chars for
 * Luna, against codex's 1,048,576-char refusal). The corpus budget governs
 * only the corpus; the extractor's instructions and the CLI's own preamble
 * ride in the same prompt, so the clamp leaves them this much room. agy's
 * "cap" is the model's silent truncation point and its 45k-token budget was
 * measured under it with headroom already, so it holds nothing back; claude
 * carries codex's number as a placeholder.
 */
export const EXTRACTOR_PROMPT_HEADROOM_CHARS: Readonly<Record<LlmBackend, number>> = Object.freeze({
  codex: 64_000,
  claude: 64_000,
  agy: 0,
})

/** The hard input cap for a backend (defaults to the strictest known cap). */
export function backendInputCapChars(backend: LlmBackend): number {
  return BACKEND_INPUT_CAP_CHARS[backend] ?? 1_048_576
}
