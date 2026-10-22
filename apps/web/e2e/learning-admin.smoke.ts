import { mkdirSync, readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

/**
 * Live smoke for the Osmosis admin pages served by the API:
 *   bun apps/web/e2e/learning-admin.smoke.ts [baseUrl] [outDir]
 * Renders the map, the policy dialog, the curriculum builder, the history
 * reader, the playground and the loop status, and saves a screenshot of each.
 * Read views only: it never starts an assessment, a curriculum run, a
 * playground turn or a vector experiment. Fails on any console error.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3010'
const out = process.argv[3] ?? '/var/tmp/learner-smoke'
const keyFile = process.env.LEARNER_HOOK_KEY_FILE ?? '/etc/learner/agent-key.env'
let key: string | undefined
try { key = readFileSync(keyFile, 'utf8').match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim() } catch { /* anonymous */ }
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const errors: string[] = []
const screenshots: string[] = []
const shot = async (page: Page, name: string) => {
  const path = `${out}/web-${name}.png`
  await page.screenshot({ path, fullPage: true })
  screenshots.push(path)
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...(key ? { extraHTTPHeaders: { 'x-api-key': key } } : {}) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

  await page.goto(`${base}/learner/osmosis`)
  await page.getByTestId('learning-map').waitFor({ timeout: 30_000 })
  await page.locator('.react-flow__node-skill').first().waitFor({ timeout: 15_000 })
  await page.getByTestId('learning-concept-assessment').waitFor()
  const tiles = await page.locator('.react-flow__node-skill .skill-node').count()
  await page.waitForTimeout(1000)
  await shot(page, 'osmosis-map')

  await page.locator('.react-flow__node-skill .skill-node').first().click()
  await page.getByTestId('skill-node-details').waitFor()
  await shot(page, 'osmosis-node-details')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Open learning policy settings' }).click()
  await page.getByRole('dialog').getByText('Extractor model', { exact: true }).waitFor()
  await page.waitForTimeout(1500)
  await shot(page, 'osmosis-policy')
  await page.keyboard.press('Escape')

  await page.goto(`${base}/learner/osmosis/build`)
  await page.getByTestId('curriculum-builder').waitFor()
  await page.waitForTimeout(1500)
  await shot(page, 'osmosis-build')

  await page.goto(`${base}/learner/osmosis/history`)
  await page.getByRole('heading', { name: 'Conversation history' }).waitFor({ timeout: 30_000 })
  await shot(page, 'osmosis-history')

  await page.goto(`${base}/learner/osmosis/playground`)
  await page.getByTestId('learning-playground').waitFor()
  await page.waitForTimeout(1000)
  await shot(page, 'osmosis-playground')

  await page.goto(`${base}/learning/status`)
  await page.waitForURL('**/learner/osmosis/status')
  await page.getByTestId('learning-catalog').locator('li').first().waitFor({ timeout: 15_000 })
  await shot(page, 'osmosis-status')

  console.log(JSON.stringify({ ok: errors.length === 0, authenticated: Boolean(key), tiles, errors, screenshots }))
  if (errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
