/**
 * LLMService — DI wrapper around lib/llm-service.
 *
 * The implementation (OpenRouter HTTP, admin-CLI bypass, structured-output
 * retry, AsyncLocalStorage user context) lives in ../lib/llm-service.ts. This
 * class is the service-injected surface: it sources config from the injected
 * `variables` (VariablesService) once, pushes it into the lib via
 * configureLLM(), and then delegates every call.
 *
 * Why this exists: lib/llm-service previously read config through a module-load
 * side-effect (importing ./env-loader and calling loadEnvFiles()), which broke the previous host's
 * Zod schema generator — the generator executes a module to introspect its
 * schema, and any step importing the extractor → llm-service chain failed
 * codegen at that require. Moving config to injection means consumers stop
 * importing the lib at module top; only services.ts loads this wrapper, and it
 * does so at runtime, never inside a step's schema-gen import chain.
 *
 * Importing the lib here is therefore safe — this file is loaded only by
 * services.ts at runtime.
 */
import type { VariablesService } from '@learner/core/runtime/types.js'

import {
  callLLM,
  callLLMWithStructuredOutput,
  configureLLM,
  createLLMTraceId,
  DEFAULT_REASONING,
  curriculumAuthoringCallOptions,
  extractorCallOptions,
  extractorInputBudgetChars,
  getLLMProvider,
  getModelForOperation,
  isLLMAvailable,
  isLLMError,
  LLMErrorTypes,
  MODELS,
  normalizeReasoning,
  personaConsolidationCallOptions,
  qualityInvestigationCallOptions,
  setLLMUserContext,
} from '../lib/llm/llm-service.js'
import type { ExtractorInputBudgetStep } from '../lib/llm/model-catalog.js'

// Config keys the lib reads. Kept in sync with LLMConfig in
// ../lib/llm-service.ts — these are the env-backed routing/auth seams.
const CONFIG_KEYS = [
  'ADMIN_CLI_BACKEND',
  'AGY_CLI_DEFAULT_MODEL',
  'EXTRACTOR_LLM_BACKEND',
  'EXTRACTOR_MODEL',
  'EXTRACTOR_REASONING',
  'EXTRACTOR_INPUT_BUDGET_TOKENS',
  'INTELLIGENCE_MODEL',
  'PERSONA_CONSOLIDATION_MODEL',
  'QUALITY_INVESTIGATION_BACKEND',
  'QUALITY_INVESTIGATION_MODEL',
  'QUALITY_INVESTIGATION_REASONING',
  'QUALITY_INVESTIGATION_LLM_TIMEOUT_SEC',
  'WEB_SEARCH_MODEL',
  'LLM_DEFAULT_REASONING',
  'OPENROUTER_API_KEY',
  'LEARNER_ADMIN_EMAILS',
  'LEARNER_ADMIN_USER_IDS',
] as const

export class LLMService {
  // Cache the one-time configuration so concurrent callers share a single
  // variables read and configureLLM() runs exactly once.
  private configured: Promise<void> | null = null

  constructor(private readonly variables: VariablesService) {}

  // Resolve config from the injected variables service and push it into the
  // lib. Runs once; subsequent calls await the cached promise.
  private ensureConfigured(): Promise<void> {
    if (!this.configured) {
      this.configured = (async () => {
        const entries = await Promise.all(
          CONFIG_KEYS.map(async (key) => {
            // VariablesService.get may be sync or async; await handles both.
            const value = await this.variables.get<string>(key)
            return [key, value] as const
          }),
        )
        const cfg: Record<string, string | undefined> = {}
        for (const [key, value] of entries) {
          // Only set keys that resolved — let the lib keep its process.env
          // fallback for anything the variables service doesn't carry.
          if (value !== undefined) cfg[key] = value
        }
        configureLLM(cfg)
      })()
    }
    return this.configured
  }

  // Readonly config-derived surfaces. MODELS is getter-backed in the lib, so a
  // direct re-export preserves its lazy reads.
  readonly MODELS = MODELS
  readonly DEFAULT_REASONING = DEFAULT_REASONING
  readonly LLMErrorTypes = LLMErrorTypes

  async callLLM(
    prompt: Parameters<typeof callLLM>[0],
    options?: Parameters<typeof callLLM>[1],
  ) {
    await this.ensureConfigured()
    return callLLM(prompt, options)
  }

  async callLLMWithStructuredOutput(
    params: Parameters<typeof callLLMWithStructuredOutput>[0],
  ) {
    await this.ensureConfigured()
    return callLLMWithStructuredOutput(params)
  }

  async isLLMAvailable() {
    await this.ensureConfigured()
    return isLLMAvailable()
  }

  // Pure error-shape checks — no config dependency, but kept on the service so
  // callers have a single injected surface.
  isLLMError(error: Parameters<typeof isLLMError>[0], type?: string) {
    return isLLMError(error, type)
  }

  extractorCallOptions(options?: Parameters<typeof extractorCallOptions>[0]) {
    return extractorCallOptions(options)
  }

  /** Authoring policy for curriculum generation — codex GPT-6 Astra at high by
   * default, redirected with CURRICULUM_MODEL / CURRICULUM_LLM_BACKEND /
   * CURRICULUM_REASONING. Not the extractor: see the function's own comment. */
  curriculumAuthoringCallOptions(options?: Parameters<typeof curriculumAuthoringCallOptions>[0]) {
    return curriculumAuthoringCallOptions(options)
  }

  // Async because the budget depends on the extractor backend/model, which
  // the variables service may override — steps ask for it before their first
  // LLM call, so it must not run ahead of configuration.
  async extractorInputBudgetChars(step?: ExtractorInputBudgetStep | null) {
    await this.ensureConfigured()
    return extractorInputBudgetChars(step)
  }

  personaConsolidationCallOptions(options?: Parameters<typeof personaConsolidationCallOptions>[0]) {
    return personaConsolidationCallOptions(options)
  }

  qualityInvestigationCallOptions(options?: Parameters<typeof qualityInvestigationCallOptions>[0]) {
    return qualityInvestigationCallOptions(options)
  }

  getLLMProvider() {
    return getLLMProvider()
  }

  getModelForOperation(operation: Parameters<typeof getModelForOperation>[0]) {
    return getModelForOperation(operation)
  }

  normalizeReasoning(value: Parameters<typeof normalizeReasoning>[0]) {
    return normalizeReasoning(value)
  }

  createLLMTraceId(label?: Parameters<typeof createLLMTraceId>[0]) {
    return createLLMTraceId(label)
  }

  setLLMUserContext(
    userInfo: Parameters<typeof setLLMUserContext>[0],
    fn: Parameters<typeof setLLMUserContext>[1],
  ) {
    return setLLMUserContext(userInfo, fn)
  }
}
