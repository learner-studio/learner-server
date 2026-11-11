import { expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { RpcOutput } from '@learner/contract'

// The view's module imports the RPC client, which reads Vite's import.meta.env; the view never calls it.
mock.module('../../lib/api', () => ({ useRpcQuery: () => ({}) }))
const { MasteryProgressStripView } = await import('./MasteryProgressStrip')

type Progress = RpcOutput<'getMasteryProgress'>
type W = Partial<Progress['windows'][number]>
const render = (held: boolean, rise: number | null, ...ws: W[]) => {
  const windows = (['24h', '7d', '30d'] as const).map((window, i) => ({ window, beforePercent: 20, nowPercent: 40.5, up: 0, firstClear: 0, compared: 0, withheldForDrift: 0, ...ws[i] }))
  const html = renderToStaticMarkup(<MemoryRouter><MasteryProgressStripView progress={{ scores: 'live', liveRisePerGrading: rise, gainsWithheldForDrift: held, due: 3, windows }} /></MemoryRouter>)
  /** Text and open tag of the element with this test id (nesting-aware), or null. */
  const el = (id: string) => {
    const open = html.match(new RegExp(`<(\\w+)([^>]*data-testid="${id}"[^>]*)>`))
    if (!open) return null
    const re = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, 'g'), start = open.index! + open[0].length
    re.lastIndex = start
    for (let depth = 1, m; (m = re.exec(html));) if ((depth += m[1] ? -1 : 1) === 0) return { attrs: open[2]!, inner: html.slice(start, m.index), text: html.slice(start, m.index).replace(/<[^>]+>/g, '') }
    return null
  }
  return { html, el }
}
const COLOUR = /emerald|rose|amber|success|green|red|accent|border/

test('label names the live grader and links to the prior-blind statistics; a ▲ window has no prior-blind line', () => {
  const a = render(false, 2.146, { up: 1, compared: 2 }), b = render(false, null)
  expect(a.el('mastery-scores-label')!.text).toBe('Before → now are the live grader’s scores: each grading starts from the previous score, and the grader alone raises a score about +2.1 points per grading, so they are not evidence of learning.')
  expect(b.el('mastery-scores-label')!.text).toBe('Before → now are the live grader’s scores: each grading starts from the previous score, so they are not evidence of learning.')
  expect(a.el('mastery-progress-link')!.attrs).toContain('href="/learner/progress"')
  expect(a.el('mastery-progress-link')!.text).toBe('Measured change (prior-blind grader) →')
  expect(a.el('mastery-prior-blind-24h')).toBeNull()
})

test('drift measured: one ▲ with its denominator; withheld rises named, never "no rise"; live figures and first clears bare', () => {
  const { html, el } = render(false, 2.1, { firstClear: 2 }, { up: 1, compared: 5, withheldForDrift: 2, firstClear: 1 }, { compared: 3, beforePercent: 50, nowPercent: 7 })
  expect(html.match(/▲/g)?.length).toBe(1)
  expect(el('mastery-up-7d')!.inner).toBe('<span aria-hidden="true">▲ </span>1 of 5 rose beyond grader noise (prior-blind)')
  expect(el('mastery-prior-blind-7d')!.text).toBe('prior-blind: no verdict yet: 2 of 5 rose beyond grader noise, not beyond the grader’s possible drift')
  expect(el('mastery-prior-blind-24h')!.text).toBe('prior-blind: no verdict yet (no concept measured twice without the previous score)')
  expect(el('mastery-prior-blind-30d')!.text).toBe('prior-blind: no rise beyond grader noise (3 concepts measured twice without the previous score)')
  expect([el('mastery-live-24h')!.text, el('mastery-live-30d')!.text]).toEqual(['20% → 40.5%', '50% → 7%'])
  for (const id of ['mastery-live-24h', 'mastery-live-7d', 'mastery-live-30d', 'mastery-first-clear-24h', 'mastery-first-clear-7d']) expect(el(id)!.attrs).not.toMatch(COLOUR)
  expect([el('mastery-first-clear-24h')!.text, el('mastery-first-clear-7d')!.text]).toEqual(['2 first clear readings (live grader)', '1 first clear reading (live grader)'])
  expect(el('mastery-prior-blind-all')).toBeNull()
})

test('the same line in every window is said once: drift unmeasured (no ▲ even with up), and measured but wide', () => {
  const held = render(true, 2.1, { up: 1, compared: 5, withheldForDrift: 3 }, { up: 1, compared: 5, withheldForDrift: 3 }, { up: 1, compared: 5, withheldForDrift: 3 })
  expect(held.html).not.toContain('▲')
  expect(held.el('mastery-prior-blind-all')!.text).toBe('24h · 7d · 30d: prior-blind: no verdict yet: 3 of 5 rose beyond grader noise (grader drift not measured)')
  expect(render(true, 2.1).el('mastery-prior-blind-all')!.text).toBe('24h · 7d · 30d: prior-blind: no verdict yet (grader drift not measured)')
  const wide = render(false, 2.1, { compared: 5, withheldForDrift: 3 }, { compared: 5, withheldForDrift: 3 }, { compared: 5, withheldForDrift: 3 })
  expect(wide.el('mastery-prior-blind-all')!.text).toBe('24h · 7d · 30d: prior-blind: no verdict yet: 3 of 5 rose beyond grader noise, not beyond the grader’s possible drift')
  expect(wide.el('mastery-prior-blind-24h')).toBeNull()
})
