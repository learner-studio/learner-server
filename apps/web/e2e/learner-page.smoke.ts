import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

/**
 * Live smoke for the built web app served by the API:
 *   bun apps/web/e2e/learner-page.smoke.ts [baseUrl] [outDir]
 * Renders the Learner home and the Osmosis page (live RPC data) and saves a
 * screenshot of each. With LEARNER_HOOK_KEY_FILE readable, requests carry the
 * machine key so Osmosis renders as the key's owner; the key is never logged.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3010'
const out = process.argv[3] ?? '/var/tmp/learner-smoke'
const keyFile = process.env.LEARNER_HOOK_KEY_FILE ?? '/etc/learner/agent-key.env'
let key: string | undefined
try { key = readFileSync(keyFile, 'utf8').match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim() } catch { /* anonymous */ }

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...(key ? { extraHTTPHeaders: { 'x-api-key': key } } : {}) })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(`${base}/learner`)
  await page.getByRole('heading', { name: 'Decide what to learn. The rest follows you around.' }).waitFor()
  for (const pillar of ['osmosis', 'feedback', 'progress']) await page.getByTestId(`learner-pillar-${pillar}`).waitFor()
  await page.screenshot({ path: `${out}/learner-home.png`, fullPage: true })

  await page.getByTestId('learner-pillar-osmosis').click()
  await page.waitForURL('**/learner/osmosis')
  // The Osmosis root is the curriculum map; the loop status (and its catalog) is one tab over.
  await page.getByTestId('osmosis-nav').getByRole('button', { name: 'Status' }).click()
  await page.waitForURL('**/learner/osmosis/status')
  const catalog = page.getByTestId('learning-catalog')
  await catalog.locator('li').first().waitFor({ timeout: 15_000 })
  const concepts = await catalog.locator('li').count()
  await page.screenshot({ path: `${out}/learner-osmosis.png`, fullPage: true })

  console.log(JSON.stringify({ ok: errors.length === 0, authenticated: Boolean(key), concepts, errors, screenshots: [`${out}/learner-home.png`, `${out}/learner-osmosis.png`] }))
  if (errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
