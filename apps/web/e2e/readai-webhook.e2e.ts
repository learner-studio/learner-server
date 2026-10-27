import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { chromium } from 'playwright'
import { READAI_WEBHOOK_TEST_HEADER, READAI_WEBHOOK_TEST_PAYLOAD } from '@learner/contract'

/**
 * Live e2e test for Settings > Integrations > Read AI webhook, end to end: the UI
 * generates and saves a token, its Send test posts the fixture meeting through
 * the PUBLIC nginx route (`/learner-api/webhooks/readai/<token>`) to the API,
 * and the card reads the delivery back. Then the public URL is probed directly:
 * an unknown token is 401, a non-Read.ai body is 400, the fixture as a test is 200.
 *   bun --env-file=/etc/learner/db.env apps/web/e2e/readai-webhook.e2e.ts [webBase] [apiUrl] [publicOrigin]
 * Tests never store a call. It REPLACES the live webhook token while it runs, so a real
 * Read.ai delivery in that minute is refused (401), and puts back the row it found (hash
 * and history) before exiting. Never prints a token.
 */
const web = process.argv[2] ?? 'http://127.0.0.1:5180/learner'
const api = process.argv[3] ?? 'http://127.0.0.1:3010'
const publicOrigin = process.argv[4] ?? 'https://dev.biztoolz.app'
const keyFile = process.env.LEARNER_HOOK_KEY_FILE ?? '/etc/learner/agent-key.env'
const key = readFileSync(keyFile, 'utf8').match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error(`No LEARNER_API_KEY in ${keyFile}`)
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (run with --env-file=/etc/learner/db.env) to restore the webhook row')
const db = new Pool({ connectionString: process.env.DATABASE_URL })
const publicUrl = (token: string) => `${publicOrigin}/learner-api/webhooks/readai/${encodeURIComponent(token)}`
const ok = (step: string) => console.log(`ok  ${step}`)
function check(condition: unknown, step: string): asserts condition { if (!condition) throw new Error(`FAILED ${step}`) }

const original = (await db.query(`SELECT * FROM learning_readai_webhook WHERE config_key = 'default'`)).rows[0] as Record<string, unknown> | undefined
const browser = await chromium.launch()
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  await page.route('**/learner/rpc/**', async (route) => {
    const request = route.request()
    const response = await fetch(`${api}/rpc/${request.url().replace(/^.*\/learner\/rpc\//, '')}`, { method: request.method(), headers: { 'content-type': 'application/json', 'x-api-key': key }, body: request.postData() ?? undefined })
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: Buffer.from(await response.arrayBuffer()) })
  })
  // The card posts to its own origin's /learner-api/...; send it to the real public host, through nginx.
  await page.route('**/learner-api/webhooks/readai/**', async (route) => {
    const request = route.request()
    const headers = request.headers()
    const response = await fetch(`${publicOrigin}${new URL(request.url()).pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', [READAI_WEBHOOK_TEST_HEADER]: headers[READAI_WEBHOOK_TEST_HEADER] ?? '' }, body: request.postData() ?? undefined })
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: Buffer.from(await response.arrayBuffer()) })
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  // The unsaved-token test is meant to 401; the browser logs that load failure, nothing else may error.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(`console: ${m.text()}`) })

  const openIntegrations = async () => {
    await page.goto(`${web}/osmosis`)
    await page.getByRole('button', { name: 'Open learning policy settings' }).click()
    await page.getByRole('tab', { name: 'Integrations' }).click()
    await page.getByTestId('readai-webhook').getByText('Read AI webhook', { exact: true }).waitFor()
    await page.getByTestId('readai-webhook-state').waitFor()
  }
  await openIntegrations()
  ok('Settings > Integrations shows the Read AI webhook card')

  const card = page.getByTestId('readai-webhook')
  await card.getByRole('button', { name: 'Generate' }).click()
  const token = await page.getByTestId('readai-webhook-token').inputValue()
  check(/^[A-Za-z0-9_-]{43}$/.test(token), 'Generate fills a 32-byte URL-safe token')
  check((await page.getByTestId('readai-webhook-url').inputValue()).endsWith(`/learner-api/webhooks/readai/${token}`), 'the URL to paste into Read.ai carries the token on the public path')
  ok('Generate fills a token and shows the public webhook URL')

  await card.getByRole('button', { name: 'Send test' }).click()
  await page.getByTestId('readai-webhook-test-error').getByText('save it first').waitFor()
  ok('Send test before saving is refused by the server (401) and says so')

  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/rpc/saveReadAiWebhook') && r.ok()), card.getByRole('button', { name: 'Save token' }).click()])
  await page.getByTestId('readai-webhook-state').getByText(`token …${token.slice(-4)}`).waitFor()
  ok('Save token: the card shows Configured with the token hint')

  await card.getByRole('button', { name: 'Send test' }).click()
  await page.getByTestId('readai-webhook-test-result').waitFor()
  await page.getByTestId('readai-webhook-last-delivery').getByText('(test)', { exact: false }).waitFor()
  check((await page.getByTestId('readai-webhook-last-delivery').innerText()).includes('test passed'), 'the last delivery reads back as a passed test')
  ok('Send test through nginx is accepted and the card reads the delivery back')

  const post = (token: string, body: unknown, test: boolean) => fetch(publicUrl(token), { method: 'POST', headers: { 'content-type': 'application/json', ...(test ? { [READAI_WEBHOOK_TEST_HEADER]: '1' } : {}) }, body: JSON.stringify(body) })
  check((await post(`${token}x`, READAI_WEBHOOK_TEST_PAYLOAD, true)).status === 401, 'an unknown token is 401 on the public URL')
  check((await post(token, { title: 'not a meeting' }, false)).status === 400, 'a non-Read.ai body is 400 and stores nothing')
  const accepted = await post(token, READAI_WEBHOOK_TEST_PAYLOAD, true)
  check(accepted.status === 200 && (await accepted.json() as { outcome?: string }).outcome === 'test-ok', 'the fixture as a test is accepted')
  check((await db.query(`SELECT 1 FROM learning_call_speech WHERE session_id = $1`, [READAI_WEBHOOK_TEST_PAYLOAD.session_id])).rows.length === 0, 'no test delivery stored a call')
  ok('public URL: 401 unknown token, 400 bad body, 200 test; no call stored')

  await openIntegrations()
  check(await page.getByTestId('readai-webhook-token').inputValue() === '', 'a reload never shows the saved token')
  await page.getByTestId('readai-webhook-state').getByText(`token …${token.slice(-4)}`).waitFor()
  ok('after a reload the token stays hidden and the hint persists')

  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/rpc/clearReadAiWebhook') && r.ok()), card.getByRole('button', { name: 'Remove' }).click()])
  await page.getByTestId('readai-webhook-state').getByText('Not configured').waitFor()
  check((await post(token, READAI_WEBHOOK_TEST_PAYLOAD, true)).status === 401, 'a removed token is refused')
  ok('Remove: Not configured, and the old URL is refused')
  check(errors.length === 0, `no page or console errors: ${errors.join(' | ')}`)
} finally {
  await browser.close()
  await db.query(`DELETE FROM learning_readai_webhook WHERE config_key = 'default'`)
  if (original) {
    await db.query(`INSERT INTO learning_readai_webhook (config_key, token_sha256, token_hint, updated_by, updated_at, last_delivery_at, last_delivery) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [original.config_key, original.token_sha256, original.token_hint, original.updated_by, original.updated_at, original.last_delivery_at, original.last_delivery])
  }
  console.log(`restored the webhook row (${original ? 'the saved token' : 'none configured'})`)
  await db.end()
}
