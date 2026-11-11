import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import type { RpcOutput } from '@learner/contract'
import { anchoredLine, changeLine, conceptsLine, efficacyLine, noiseLine, powerLine, velocityLine, VERDICT_FELL, VERDICT_NONE, VERDICT_ROSE, feedLine } from '../src/pages/progress/progress-statistics-model'

/**
 * Live e2e test for the Progress page's mastery statistics (docs/specs/mastery-change-statistics.md).
 * Read-only.
 *   bun apps/web/e2e/mastery-statistics.e2e.ts [webBase] [apiUrl] [screenshot]
 * Checks: the change, velocity, concepts, anchored, noise, efficacy and power lines each equal what the server's
 * getMasteryChanges / getHoldoutEffect figures render to; the change line is signed and carries its
 * 95 % interval (or says why there is none); the efficacy line shows the baseline state until the
 * minimum is reached; no console error. Saves a screenshot outside the repo (it shows the learner's data).
 */
const web = process.argv[2] ?? 'http://127.0.0.1:5180/learner'
const api = process.argv[3] ?? 'http://127.0.0.1:3010'
const shot = process.argv[4] ?? '/var/lib/learner/e2e/progress-statistics.png'
const keyFile = process.env.LEARNER_HOOK_KEY_FILE ?? '/etc/learner/agent-key.env'
const key = readFileSync(keyFile, 'utf8').match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error(`No LEARNER_API_KEY in ${keyFile}`)

const rpc = async <T>(name: string, data: unknown): Promise<T> => {
  const response = await fetch(`${api}/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ data }) })
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`)
  return response.json() as Promise<T>
}
let failures = 0
const check = (step: string, ok: boolean, detail: unknown) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const browser = await chromium.launch()
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  await page.route('**/learner/rpc/**', async (route) => {
    const request = route.request()
    const name = request.url().replace(/^.*\/learner\/rpc\//, '')
    const response = await fetch(`${api}/rpc/${name}`, { method: request.method(), headers: { 'content-type': 'application/json', 'x-api-key': key }, body: request.postData() ?? undefined })
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: Buffer.from(await response.arrayBuffer()) })
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

  await page.goto(`${web}/progress`)
  const panel = page.getByTestId('mastery-statistics')
  await panel.waitFor({ timeout: 30_000 })
  await page.getByTestId('mastery-noise-line').waitFor({ timeout: 60_000 })
  await page.getByTestId('mastery-efficacy-line').filter({ hasNotText: 'Loading' }).waitFor({ timeout: 60_000 })

  // The server's figures, read after the page: both move only with new readings.
  const [changes, holdout] = await Promise.all([
    rpc<RpcOutput<'getMasteryChanges'>>('getMasteryChanges', { sinceDays: null }),
    rpc<RpcOutput<'getHoldoutEffect'>>('getHoldoutEffect', {}),
  ])
  const text = async (id: string) => (await page.getByTestId(id).count()) ? (await page.getByTestId(id).innerText()).trim() : null

  const change = await text('mastery-change-line')
  check('change line equals the server', change === changeLine(changes), change)
  const a = changes.aggregate
  if (a.changeInterval) check('change line carries its interval and verdict', [VERDICT_ROSE, VERDICT_FELL, VERDICT_NONE].some((v) => change?.endsWith(`: ${v}.`)) && /95% .+ to .+/.test(change ?? ''), change)
  check('concepts line equals the server', (await text('mastery-concepts-line')) === conceptsLine(changes), await text('mastery-concepts-line'))
  check('anchored line equals the server', (await text('mastery-anchored-line')) === anchoredLine(changes), await text('mastery-anchored-line'))
  check('conclusive matches the interval', a.conclusive === (!!a.changeInterval && (a.changeInterval.low > 0 || a.changeInterval.high < 0)), { conclusive: a.conclusive, interval: a.changeInterval })
  const velocity = velocityLine(changes)
  check('velocity line equals the server', (await text('mastery-velocity-line')) === (velocity ? `Velocity: ${velocity}` : null), await text('mastery-velocity-line'))
  check('noise line equals the server', (await text('mastery-noise-line')) === noiseLine(changes), await text('mastery-noise-line'))
  check('feed line equals the server (S10)', (await text('mastery-feed-line')) === feedLine(changes), await text('mastery-feed-line'))
  check('efficacy line equals the server', (await text('mastery-efficacy-line')) === efficacyLine(holdout), await text('mastery-efficacy-line'))
  if (holdout.estimate.state === 'setting_baseline') check('baseline state until the minimum', (await text('mastery-efficacy-line'))?.includes(`All readings: setting baseline: ${holdout.estimate.measuredTwice.heldOut} of ${holdout.estimate.minimumPerArm} held-out`) ?? false, await text('mastery-efficacy-line'))
  check('power line equals the server', (await text('mastery-power-line')) === powerLine(holdout), await text('mastery-power-line'))
  console.log(`numbers: ${JSON.stringify({ aggregate: a, noise: changes.noise, anchored: changes.anchored, gainThreshold: changes.gainThreshold, holdout: { phase: holdout.phase, buckets: holdout.buckets, ...holdout.estimate } })}`)

  mkdirSync(shot.replace(/\/[^/]+$/, ''), { recursive: true, mode: 0o700 })
  await page.screenshot({ path: shot, fullPage: false })
  chmodSync(shot, 0o600)
} finally {
  await browser.close()
}
check('no page or console errors', errors.length === 0, errors)
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('mastery statistics e2e: all checks passed')
