import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

/**
 * Live e2e test for the intervention policy dialog: drives the policy sliders (prerequisite fallback,
 * injection rate, spaced repetition and its hop distance) and the extractor model, saves, and reads
 * each save back through `getLearningPolicy` / `getLearningExtractorConfig`. The dialog must always
 * show what the server holds: a value written behind its back appears on the next refetch.
 *   bun apps/web/e2e/learning-policy.e2e.ts [webBase] [apiUrl]
 * The web base defaults to the dev Vite server (`/learner/`); its `/learner/rpc` calls, which nginx
 * strips on the shared host, are routed to the API here. It WRITES the live policy and extractor
 * selection and restores the ones it found before exiting. The stored loads are delayed so an edit made while it is in
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

const storedExtractor = async () => {
  const { backend, model, effort } = await rpc('getLearningExtractorConfig', {})
  return `${backend} / ${model} / ${effort}`
}

const { updatedAt: _updatedAt, ...original } = await rpc('getLearningPolicy', {})
const { updatedAt: _extractorUpdatedAt, ...originalExtractor } = await rpc('getLearningExtractorConfig', {})
const browser = await chromium.launch()
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  await page.route('**/learner/rpc/**', async (route) => {
    const request = route.request()
    const name = request.url().replace(/^.*\/learner\/rpc\//, '')
    if (name === 'getLearningPolicy' || name === 'getLearningExtractorConfig') await new Promise((resolve) => setTimeout(resolve, LOAD_DELAY_MS))
    const response = await fetch(`${api}/rpc/${name}`, { method: request.method(), headers: { 'content-type': 'application/json', 'x-api-key': key }, body: request.postData() ?? undefined })
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: Buffer.from(await response.arrayBuffer()) })
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

  const card = page.getByTestId('learning-prerequisite-fallback')
  const open = async () => { await page.getByRole('button', { name: 'Open learning policy settings' }).click(); await card.waitFor() }
  const press = async (label: string, keys: string[]) => { const thumb = page.getByRole('slider', { name: label }); await thumb.focus(); for (const k of keys) await thumb.press(k) }
  /** Click a save button and wait for that save's own response (a second section's Saved badge would match too early). */
  const saveVia = async (button: string, rpcName: string) => { await Promise.all([page.waitForResponse((r) => r.url().endsWith(`/rpc/${rpcName}`) && r.ok()), page.getByRole('button', { name: button }).click()]) }
  const save = () => saveVia('Save policy', 'saveLearningPolicyFunction')
  const shown = async () => (await card.innerText()).match(/inject\s*(\d)[\s\S]*?fallback\s*(All|\d hops?)/)?.slice(1).join(' / ') ?? '(unreadable)'

  const saveExtractor = page.getByRole('button', { name: 'Save extractor model' })
  const effortSelect = page.getByLabel('Reasoning effort')
  const modelSelect = page.getByLabel('CLI and model')
  const extractorShown = async () => `${(await modelSelect.inputValue()).replace(':', ' / ')} / ${await effortSelect.inputValue()}`
  const unsaved = page.getByText('Unsaved changes', { exact: true })
  const refetch = async () => { await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) }); await page.waitForTimeout(LOAD_DELAY_MS + 1000) }

  await page.goto(`${web}/osmosis`)
  await page.getByRole('button', { name: 'Open learning policy settings' }).click()
  await page.getByTestId('learning-policy-loading').waitFor()
  console.log('ok  the dialog shows a spinner, not placeholder values, until the stored policy arrives')
  if (await saveExtractor.isEnabled()) throw new Error('Save extractor model is enabled before the stored selection has loaded')
  console.log('ok  the extractor cannot be saved before the stored selection arrives')
  await card.waitFor()
  await modelSelect.waitFor()

  expectEqual('the extractor shows the stored selection', await extractorShown(), await storedExtractor())
  const backends = new Set((await modelSelect.locator('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).map((value) => value.split(':')[0]))
  expectEqual('extractor options offer only codex and claude', [...backends].sort().join(', '), 'claude, codex')
  const agy = await fetch(`${api}/rpc/saveLearningExtractorConfigFunction`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ data: { backend: 'agy', model: 'gemini-3.7-flash', effort: 'high' } }) })
  expectEqual('the server refuses an agy extractor', String(agy.status), '422')

  const efforts = await effortSelect.locator('option:not([disabled])').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))
  const otherEffort = efforts.find((effort) => effort !== originalExtractor.effort)
  if (!otherEffort) throw new Error(`No second selectable effort for ${originalExtractor.model}`)
  await effortSelect.selectOption(otherEffort)
  await unsaved.waitFor()
  console.log('ok  an unsaved extractor choice is flagged')
  await page.getByRole('button', { name: 'Close', exact: true }).last().click(); await open(); await modelSelect.waitFor()
  expectEqual('closing discards an unsaved extractor choice', await extractorShown(), await storedExtractor())
  if (await unsaved.count()) throw new Error('Unsaved changes still flagged after reopening')
  await effortSelect.selectOption(otherEffort); await saveVia('Save extractor model', 'saveLearningExtractorConfigFunction')
  expectEqual('the extractor choice saved', await storedExtractor(), `${originalExtractor.backend} / ${originalExtractor.model} / ${otherEffort}`)
  await rpc('saveLearningExtractorConfigFunction', originalExtractor)
  await refetch()
  expectEqual('an extractor change made on the server appears in the dialog', await extractorShown(), await storedExtractor())

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
  const { updatedAt: _now, ...current } = await rpc('getLearningPolicy', {})
  await rpc('saveLearningPolicyFunction', { ...current, prerequisiteCount: 4 })
  await refetch()
  expectEqual('a policy change made on the server appears in the dialog', await shown(), '4 / 2 hops')
} finally {
  await browser.close()
  await rpc('saveLearningPolicyFunction', original)
  await rpc('saveLearningExtractorConfigFunction', originalExtractor)
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log('learning policy e2e: ok')
