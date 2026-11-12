// Driven by llm-limits.test.ts in its own process: cli-agents.ts reads CODEX_CLI_BIN when first imported, so the fake
// binary must be set before any import. Prints one JSON line of results.
import { cliGovernorState, cliPauseMs, enableCliGovernor, noteCliRateLimited } from '../llm-limits.js'
import { callLLM } from '../llm-service.js'

const call = () => callLLM('governor probe', { backend: 'codex', model: 'gpt-5.6-luna', effort: 'low', timeout: 30, killMs: 30_000 })
if (process.env.FAKE_CODEX_MODE === '429') {
  enableCliGovernor({ max: 6, min: 2, baseMs: 1, capMs: 5, random: () => 0.5 })
  const errors: string[] = []
  for (let i = 0; i < 2; i++) await call().catch((e: unknown) => { errors.push(String((e as { message?: string })?.message ?? e)) })
  console.log(JSON.stringify({ errors, state: cliGovernorState(), pauseAfter: cliPauseMs(0) }))
} else {
  // The cap is lowered (4 -> 3) while 4 calls run: the 4 queued calls must then run at most 3 at a time.
  enableCliGovernor({ max: 4, min: 2, baseMs: 1, capMs: 1, random: () => 0.5 })
  const calls = Array.from({ length: 8 }, () => call())
  await Bun.sleep(150)
  noteCliRateLimited(); noteCliRateLimited()
  await Promise.all(calls)
  console.log(JSON.stringify({ state: cliGovernorState() }))
}
process.exit(0)
