import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

/**
 * Live smoke for the intervention policy dialog: drives the sliders, saves, and reads each save
 * back through `getLearningPolicy` (prerequisite fallback, injection rate, spaced repetition and its
 * hop distance).
 *   bun apps/web/e2e/learning-policy.smoke.ts [webBase] [apiUrl]
 * The web base defaults to the dev Vite server (`/learner/`); its `/learner/rpc` calls, which nginx
 * strips on the shared host, are routed to the API here. It WRITES the live policy and restores the
 * one it found before exiting. The stored-policy load is delayed so an edit made while it is in
 * flight, or a refetch, would show if it overwrote the form. Fails on any mismatch or console error.
 */
const web = process.argv[2] ?? 'http://127.0.0.1:5180/learner'
const api = process.argv[3] ?? 'http://127.0.0.1:3010'
const keyFile = process.env.LEARNER_HOOK_KEY_FILE ?? '/etc/learner/agent-key.env'
const key = readFileSync(keyFile, 'utf8').match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error(`No LEARNER_API_KEY in ${keyFile}`)
const LOAD_DELAY_MS = 1500

const rpc = async (name: string, data: unknown) => {
  const response = await fetch(`${api}/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ data }) })
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`)
  return response.json()
}
const stored = async () => {
  const { prerequisiteCount, prerequisiteDepth, injectionRate } = await rpc('getLearningPolicy', {})
  return `${prerequisiteCount} / ${prerequisiteDepth} / ${injectionRate}`
}
const storedReview = async () => {
  const { spacedRepetition, reviewHops } = await rpc('getLearningPolicy', {})
  return `${spacedRepetition ? 'on' : 'off'} / ${reviewHops}`
}
const expectEqual =(step: string, actual: string, expected: string) => {
  if (actual !== expected) throw new Error(`${step}: got ${actual}, expected ${expected}`)
  console.log(`ok  ${step}: ${actual}`)
}

const { updatedAt: _updatedAt, ...original } = await rpc('getLearningPolicy', {})
const browser = await chromium.launch()
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  await page.route('**/learner/rpc/**', async (route) => {
    const request = route.request()
    const name = request.url().replace(/^.*\/learner\/rpc\//, '')
    if (name === 'getLearningPolicy') await new Promise((resolve) => setTimeout(resolve, LOAD_DELAY_MS))
    const response = await fetch(`${api}/rpc/${name}`, { method: request.method(), headers: { 'content-type': 'application/json', 'x-api-key': key }, body: request.postData() ?? undefined })
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: Buffer.from(await response.arrayBuffer()) })
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

  const card = page.getByTestId('learning-prerequisite-fallback')
  const open = async () => { await page.getByRole('button', { name: 'Open learning policy settings' }).click(); await card.waitFor() }
  const press = async (label: string, keys: string[]) => { const thumb = page.getByRole('slider', { name: label }); await thumb.focus(); for (const k of keys) await thumb.press(k) }
  const save = async () => { await page.getByRole('button', { name: 'Save policy' }).click(); await page.getByText('Saved', { exact: true }).last().waitFor() }
  const shown = async () => (await card.innerText()).match(/inject\s*(\d)[\s\S]*?fallback\s*(All|\d hops?)/)?.slice(1).join(' / ') ?? '(unreadable)'

  await page.goto(`${web}/osmosis`)
  await page.getByRole('button', { name: 'Open learning policy settings' }).click()
  await page.getByTestId('learning-policy-loading').waitFor()
  console.log('ok  the dialog shows a spinner, not placeholder values, until the stored policy arrives')
  await card.waitFor()

  await press('Prerequisite concepts to inject', ['End']); await press('Depth of prerequisite fallback', ['End']); await press('Injection rate', ['Home', 'ArrowRight', 'ArrowRight', 'ArrowRight'])
  await save(); expectEqual('count 5, depth All, rate 60 saved', await stored(), '5 / all / 60')
  await press('Prerequisite concepts to inject', ['Home']); await press('Depth of prerequisite fallback', ['Home', 'ArrowRight', 'ArrowRight'])
  await save(); expectEqual('count 1, depth 3 saved', await stored(), '1 / 3 / 60')

  const review = page.getByTestId('learning-spaced-repetition')
  const reviewSwitch = review.getByRole('switch', { name: /^Spaced repetition/ })
  const reviewShown = async () => `${await reviewSwitch.getAttribute('aria-checked') === 'true' ? 'on' : 'off'} / ${(await review.innerText()).match(/relevancy\s*(All|\d hops?)/)?.[1] ?? '(unreadable)'}`
  if (await reviewSwitch.getAttribute('aria-checked') !== 'true') await reviewSwitch.click()
  await press('Hop distance for relevancy', ['End'])
  await save(); expectEqual('spaced repetition on, hops All saved', await storedReview(), 'on / 5')
  await press('Hop distance for relevancy', ['Home', 'ArrowRight']); await reviewSwitch.click()
  await save(); expectEqual('spaced repetition off, hops 2 saved', await storedReview(), 'off / 2')

  await page.reload(); await open()
  expectEqual('a reload shows the stored policy', await shown(), '1 / 3 hops')
  expectEqual('a reload shows the stored review setting', await reviewShown(), 'off / 2 hops')
  await press('Prerequisite concepts to inject', ['ArrowRight'])
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(LOAD_DELAY_MS + 1000)
  expectEqual('an unsaved edit survives a refetch', await shown(), '2 / 3 hops')

  await page.getByRole('button', { name: 'Reset to defaults' }).click(); await save()
  expectEqual('reset to defaults saved', await stored(), '2 / 2 / 40')
  expectEqual('reset restores the review defaults', await storedReview(), 'off / 1')
  await page.getByRole('button', { name: 'Close', exact: true }).last().click(); await open()
  expectEqual('reopening after a save shows what was saved', await shown(), '2 / 2 hops')
} finally {
  await browser.close()
  await rpc('saveLearningPolicyFunction', original)
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log('learning policy smoke: ok')
