import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

/**
 * Live e2e test for the Osmosis Map's progress strip (docs/specs/mastery-notifications.md S5) and
 * the `?conceptId=` deep link the desktop toast opens. Read-only.
 *   bun apps/web/e2e/mastery-progress.e2e.ts [webBase] [apiUrl] [screenshot]
 * The web base defaults to the dev Vite server (`/learner/`), which is what dev.biztoolz.app/learner
 * proxies to behind its login gate; `/learner/rpc` calls are routed to the API with the agent key.
 * Checks: the strip sits above the tree and graph; every window shows exactly the server's
 * before → now and ▲ up figures; the due count and the baseline line match the server; no decline
 * marker anywhere in the strip; the deep-linked concept (not the default first one) is the one
 * inspected, a deep link into another curriculum opens that curriculum, and an unknown one says so. Saves a screenshot outside the repo (it shows the learner's data). Fails on any
 * mismatch or console error.
 */
const web = process.argv[2] ?? 'http://127.0.0.1:5180/learner'
const api = process.argv[3] ?? 'http://127.0.0.1:3010'
const shot = process.argv[4] ?? '/var/lib/learner/e2e/osmosis-progress-strip.png'
const keyFile = process.env.LEARNER_HOOK_KEY_FILE ?? '/etc/learner/agent-key.env'
const key = readFileSync(keyFile, 'utf8').match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim()
if (!key) throw new Error(`No LEARNER_API_KEY in ${keyFile}`)

const rpc = async (name: string, data: unknown) => {
  const response = await fetch(`${api}/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ data }) })
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`)
  return response.json()
}
let failures = 0
const check = (step: string, ok: boolean, detail: unknown) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const pct = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)}%`

const graph = await rpc('getLearningGraph', {}) as { selectedCurriculumId: string; curriculum: { modules: Array<{ conceptIds: string[] }> } }
const conceptIds = [...new Set(graph.curriculum.modules.flatMap((m) => m.conceptIds))].sort()
// A concept from a later module, so the default selection (the first module's first concept) cannot pass for it.
const deepLinked = graph.curriculum.modules.at(-1)?.conceptIds[0]
if (!deepLinked || deepLinked === graph.curriculum.modules[0]?.conceptIds[0]) throw new Error('Need a curriculum with two modules for the deep-link check')

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

  await page.goto(`${web}/osmosis?conceptId=${encodeURIComponent(deepLinked)}`)
  const strip = page.getByTestId('mastery-progress')
  await page.getByTestId('mastery-window-24h').waitFor({ timeout: 30_000 })
  await page.getByTestId('mastery-baseline').waitFor({ timeout: 30_000 })

  // The server's figures, read after the page so both describe the same moment (they move only with new readings).
  const [progress, baseline] = await Promise.all([rpc('getMasteryProgress', { conceptIds }), rpc('getBaselineStatus', {})]) as [
    { windows: Array<{ window: string; beforePercent: number; nowPercent: number; up: number }>; due: number },
    { learning: { have: number; need: number; daysLeft: number | null } },
  ]
  for (const w of progress.windows) {
    const cell = page.getByTestId(`mastery-window-${w.window}`)
    const text = (await cell.innerText()).replace(/\s+/g, ' ')
    check(`${w.window} before → now`, text.includes(`${pct(w.beforePercent)} → ${pct(w.nowPercent)}`), text)
    const up = page.getByTestId(`mastery-up-${w.window}`)
    if (w.up > 0) check(`${w.window} ▲ up`, (await up.innerText()).trim() === `▲ ${w.up.toLocaleString('en-US')} up`, await up.innerText())
    else check(`${w.window} no ▲ when nothing went up`, (await up.count()) === 0, 'absent')
  }
  check('due for review', (await page.getByTestId('mastery-due').innerText()).trim() === `${progress.due.toLocaleString('en-US')} due for review`, await page.getByTestId('mastery-due').innerText())
  const line = (await page.getByTestId('mastery-baseline').innerText()).trim()
  const days = baseline.learning.daysLeft === null ? 'estimating your pace' : baseline.learning.daysLeft === 0 ? 'baseline reached' : `about ${baseline.learning.daysLeft.toLocaleString('en-US')} days at this pace`
  check('baseline line', line === `${baseline.learning.have.toLocaleString('en-US')} of ${baseline.learning.need.toLocaleString('en-US')} concepts tracking · ${days}`, line)
  const stripText = await strip.innerText()
  check('no decline marker', !/[▼↓]|down\b|declin/i.test(stripText), stripText.replace(/\s+/g, ' '))

  // Above the tree and graph.
  const stripBox = await strip.boundingBox()
  const treeBox = await page.getByTestId('learning-map').locator('.grid').first().boundingBox()
  check('strip above the tree and graph', !!stripBox && !!treeBox && stripBox.y + stripBox.height <= treeBox.y, { strip: stripBox?.y, tree: treeBox?.y })

  // ?conceptId= is honoured.
  const inspector = page.getByTestId('concept-inspector')
  await inspector.waitFor({ timeout: 30_000 })
  check('deep-linked concept inspected', (await inspector.getAttribute('data-concept-id')) === deepLinked, await inspector.getAttribute('data-concept-id'))
  check('deep link kept in the URL', new URL(page.url()).searchParams.get('conceptId') === deepLinked, page.url())

  // A deep link into another curriculum opens that curriculum; an unknown concept says so.
  const graphs = await Promise.all(((await rpc('getLearningGraph', {})) as { availableCurriculums: Array<{ id: string }> }).availableCurriculums
    .map(async (c) => rpc('getLearningGraph', { curriculumId: c.id }) as Promise<{ selectedCurriculumId: string; curriculum: { modules: Array<{ conceptIds: string[] }> } }>))
  const other = graphs.find((g) => g.selectedCurriculumId !== graph.selectedCurriculumId && g.curriculum.modules.some((m) => m.conceptIds.length))
  if (other) {
    const otherConcept = other.curriculum.modules.find((m) => m.conceptIds.length)!.conceptIds.at(-1)!
    const second = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    await second.route('**/learner/rpc/**', async (route) => {
      const request = route.request()
      const response = await fetch(`${api}/rpc/${request.url().replace(/^.*\/learner\/rpc\//, '')}`, { method: request.method(), headers: { 'content-type': 'application/json', 'x-api-key': key }, body: request.postData() ?? undefined })
      await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: Buffer.from(await response.arrayBuffer()) })
    })
    second.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    await second.goto(`${web}/osmosis?conceptId=${encodeURIComponent(otherConcept)}`)
    await second.getByTestId('concept-inspector').waitFor({ timeout: 30_000 })
    check('deep link into another curriculum opens it', (await second.getByTestId('concept-inspector').getAttribute('data-concept-id')) === otherConcept, other.selectedCurriculumId)
    await second.goto(`${web}/osmosis?conceptId=no-such-concept`)
    await second.getByTestId('deep-link-missing').waitFor({ timeout: 30_000 })
    check('unknown deep-linked concept is reported', (await second.getByTestId('deep-link-missing').count()) === 1, 'Concept not found shown')
    await second.close()
  } else console.log('skip deep link into another curriculum: only one curriculum with concepts')

  mkdirSync(shot.replace(/\/[^/]+$/, ''), { recursive: true, mode: 0o700 })
  await page.screenshot({ path: shot, fullPage: false })
  chmodSync(shot, 0o600)
  console.log(`screenshot ${shot} (mode 600: the learner's data, not for the repo)`)
} finally {
  await browser.close()
}
check('no console errors', errors.length === 0, errors)
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('mastery progress strip e2e: all checks passed')
