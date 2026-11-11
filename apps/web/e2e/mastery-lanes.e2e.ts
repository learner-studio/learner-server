import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Client } from 'pg'
import { chromium } from 'playwright'
import { HoldoutEffect, MasteryChanges, type RpcOutput } from '@learner/contract'
import type { QueryFn } from '../../../packages/core/src/db/handle'
import { FALLBACK_ANCHORED_SD, FALLBACK_BLIND_SD, type GraderNoiseComponents } from '../../../packages/core/src/lib/learning/grader-noise'
import { currentHoldoutPhase, holdoutReport, masteryChanges } from '../../../packages/core/src/lib/learning/mastery-change'
import { GRADER_CALIBRATION, KNOWN_TRUTH_LANE_ORDER, KNOWN_TRUTH_LANES, learnerVerdicts, simulateLearner, type KnownTruthLane } from '../../../packages/core/src/lib/learning/mastery-known-truth'
import { seedSimLearner } from '../../../packages/core/src/lib/learning/mastery-known-truth-seed'
import { GAIN_MIN_POINTS } from '../../../packages/core/src/lib/learning/mastery-notifications'
import { holdoutEffectOutput, masteryChangesOutput } from '../../../packages/server/src/functions/learning/mastery-statistics-output'
import { changeLine, efficacyLine, feedLine, noiseLine, velocityLine, VERDICT_NONE, VERDICT_ROSE } from '../src/pages/progress/progress-statistics-model'

/**
 * The known-truth study's four lanes on the mastery page (docs/specs/mastery-change-statistics.md,
 * "Known-truth recovery"): a learner who learns nothing, and slow, medium and fast learners (0, 1, 2.5,
 * 5 points a week), simulated with fixed seeds and graded by the grader calibrated on the live one.
 *
 *   (set -a; . <env with TEST_DATABASE_URL>; bun apps/web/e2e/mastery-lanes.e2e.ts [--k 3] [--shots DIR])
 *
 * Each learner is written as real rows (seedSimLearner) inside ONE transaction on the test database
 * that is rolled back at the end, read by the server's own statistics (masteryChanges, holdoutReport)
 * and shaped by the RPCs' own output functions. This checkout's web app (a Vite server it starts) asks
 * for getMasteryChanges / getHoldoutEffect; the browser's calls are answered with that learner's
 * figures and validated by the contract client as in production. Checks, per lane: every line equals
 * the render of the server's figures; the change and velocity intervals cover the TRUE change and
 * slope; lane none is "not distinguishable from no change" and the others "readings rose"; velocities
 * rank none < slow < medium < fast; the probe headline gives no verdict (no teaching effect planted);
 * no console error. Grader noise is the calibrated one (fixed), not whatever the test database holds.
 * Screenshots are synthetic data only.
 */
const args = process.argv.slice(2)
const arg = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : fallback)
const K = Number(arg('--k', '3'))
const SHOTS = arg('--shots', resolve(process.env.TMPDIR ?? '/var/tmp', 'learner-e2e/mastery-lanes'))
const PORT = Number(arg('--port', '5191'))
const SEED = 7
const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('TEST_DATABASE_URL is required (a test database: everything written is rolled back)')
const NOISE: GraderNoiseComponents = {
  blind: { sd: FALLBACK_BLIND_SD, df: 329, groups: 165, source: 'measured' },
  anchored: { sd: FALLBACK_ANCHORED_SD, df: 501, groups: 250, source: 'measured' },
  drift: { gradings: 0, meanMove: null, sdMove: null, equal: null, up: null, down: null },
}

let failures = 0
const check = (step: string, ok: boolean, detail: unknown) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const web = spawn(resolve(import.meta.dir, '../../../node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: resolve(import.meta.dir, '..'), env: { ...process.env, LEARNER_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'],
})
const ready = new Promise<void>((done, fail) => {
  const timer = setTimeout(() => fail(new Error('vite did not start in 60 s')), 60_000)
  web.stdout.on('data', (b: Buffer) => { if (/Local:/.test(b.toString())) { clearTimeout(timer); done() } })
  web.on('exit', (code) => fail(new Error(`vite exited ${code}`)))
})

const client = new Client({ connectionString: url })
const browser = await chromium.launch()
try {
  await client.connect()
  await client.query('BEGIN')
  const query = (async (text: string, params?: ReadonlyArray<unknown>) => {
    const r = await client.query(text, params ? [...params] : [])
    return { rows: r.rows, rowCount: r.rowCount ?? 0 }
  }) as QueryFn
  const phase = await currentHoldoutPhase(query)
  const tag = randomUUID().slice(0, 8)
  await ready
  mkdirSync(SHOTS, { recursive: true })
  const velocity = new Map<KnownTruthLane, number>()

  for (const lane of KNOWN_TRUTH_LANE_ORDER) {
    const s = simulateLearner({ lane, seed: SEED, k: K, taughtReadMultiplier: 2, probesPerWeek: 1 })
    const truth = learnerVerdicts(s, GRADER_CALIBRATION.blind.sd, GAIN_MIN_POINTS, 300)
    const seeded = await seedSimLearner(query, s, { phaseStartedAt: Date.parse(phase.startedAt), tag })
    const now = new Date(seeded.end)
    const out = await masteryChanges(query, seeded.userId, { sinceDays: null }, now, NOISE)
    const names = new Map((await query<{ id: string; title: string }>('SELECT id, title FROM learning_concepts WHERE id = ANY($1::text[])', [out.concepts.map((c) => c.conceptId)])).rows.map((r) => [r.id, r.title]))
    const changes: RpcOutput<'getMasteryChanges'> = MasteryChanges.parse(masteryChangesOutput(out, names))
    const holdout: RpcOutput<'getHoldoutEffect'> = HoldoutEffect.parse(holdoutEffectOutput(await holdoutReport(query, seeded.userId, NOISE, now)))

    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
    await page.route('**/api/auth/get-session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }))
    await page.route('**/rpc/**', async (route) => {
      const name = route.request().url().replace(/^.*\/rpc\//, '')
      const body = name === 'getMasteryChanges' ? changes : name === 'getHoldoutEffect' ? holdout : null
      await route.fulfill(body ? { status: 200, contentType: 'application/json', body: JSON.stringify(body) } : { status: 404, contentType: 'application/json', body: JSON.stringify({ message: `not part of this test: ${name}` }) })
    })
    await page.goto(`http://127.0.0.1:${PORT}/learner/progress`)
    await page.getByTestId('mastery-noise-line').waitFor({ timeout: 60_000 })
    await page.getByTestId('mastery-efficacy-line').filter({ hasNotText: 'Loading' }).waitFor({ timeout: 60_000 })
    const text = async (id: string) => ((await page.getByTestId(id).count()) ? (await page.getByTestId(id).innerText()).trim() : null)
    const L = `${lane} (${KNOWN_TRUTH_LANES[lane]}/week, k = ${K})`

    const change = await text('mastery-change-line')
    check(`${L} change line equals the server`, change === changeLine(changes), change)
    check(`${L} verdict`, change?.includes(lane === 'none' ? VERDICT_NONE : VERDICT_ROSE) ?? false, lane === 'none' ? 'not distinguishable' : 'rose')
    const a = changes.aggregate
    check(`${L} change interval covers the true change`, !!a.changeInterval && a.changeInterval.low <= truth.trueChange! && truth.trueChange! <= a.changeInterval.high, { interval: a.changeInterval, truth: truth.trueChange })
    const v = await text('mastery-velocity-line')
    check(`${L} velocity line equals the server`, v === `Velocity: ${velocityLine(changes)}`, v)
    check(`${L} velocity interval covers the true slope`, !!a.slopeInterval && a.slopeInterval.low <= truth.trueSlope! && truth.trueSlope! <= a.slopeInterval.high, { interval: a.slopeInterval, truth: truth.trueSlope })
    velocity.set(lane, a.meanSlopePerWeek!)
    check(`${L} noise line equals the server`, (await text('mastery-noise-line')) === noiseLine(changes), await text('mastery-noise-line'))
    check(`${L} feed line equals the server`, (await text('mastery-feed-line')) === feedLine(changes), await text('mastery-feed-line'))
    const eff = await text('mastery-efficacy-line')
    check(`${L} efficacy line equals the server`, eff === efficacyLine(holdout), eff)
    check(`${L} probe headline: no teaching effect planted, no verdict`, !!holdout.probe && !/scored (higher|lower) on probes/.test(eff ?? ''), holdout.probe?.interval ?? holdout.probe?.state ?? null)
    check(`${L} no console error`, errors.length === 0, errors)
    await page.screenshot({ path: `${SHOTS}/${lane}.png`, fullPage: true })
    await page.close()
  }
  const order = KNOWN_TRUTH_LANE_ORDER.map((l) => velocity.get(l)!)
  check('velocities rank none < slow < medium < fast', order.every((x, i) => i === 0 || x > order[i - 1]!), Object.fromEntries(velocity))
  console.log(`screenshots: ${dirname(`${SHOTS}/x`)}`)
} finally {
  await client.query('ROLLBACK').catch(() => undefined)
  await client.end().catch(() => undefined)
  await browser.close()
  web.kill('SIGTERM')
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
