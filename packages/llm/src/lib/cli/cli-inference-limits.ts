/** Transport retries and captured bytes are not a provider inference/spend budget.
 * Keep unsupported hard requirements fail-closed instead of silently ignoring them.
 * Codex 0.154.0 / AGY 1.2.7 expose no verified generated-token or whole-turn
 * request ceiling. A successful tool/empty-output continuation is not a retry.
 */
export interface CliInferenceLimits {
  providerRetries?: 0
  maxCapturedOutputBytes?: number
  maxGeneratedTokens?: number
  maxProviderRequests?: number
}
export function validateCliInferenceLimits(value: unknown, agent: string): CliInferenceLimits | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('inferenceLimits must be an object')
  const limits = value as CliInferenceLimits
  for (const key of Object.keys(value)) {
    if (!['providerRetries', 'maxCapturedOutputBytes', 'maxGeneratedTokens', 'maxProviderRequests'].includes(key)) throw new Error(`Unknown inferenceLimits field: ${key}`)
  }
  if (limits.maxProviderRequests !== undefined || limits.maxGeneratedTokens !== undefined) {
    throw new Error(`${agent}: hard maxProviderRequests/maxGeneratedTokens not supported by the verified native CLI transport; retries and captured bytes are not substitutes`)
  }
  if (limits.providerRetries !== undefined && (limits.providerRetries !== 0 || !['codex', 'agy'].includes(agent))) {
    throw new Error('providerRetries supports only zero on codex/agy')
  }
  if (limits.maxCapturedOutputBytes !== undefined && (!Number.isSafeInteger(limits.maxCapturedOutputBytes) || limits.maxCapturedOutputBytes < 1 || limits.maxCapturedOutputBytes > 16 * 1024 * 1024)) {
    throw new Error('maxCapturedOutputBytes must be an integer in 1..16777216')
  }
  return limits
}
