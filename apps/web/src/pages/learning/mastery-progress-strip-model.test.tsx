import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { RpcOutput } from '@learner/contract'
import { anchoredLine, changeLine } from '../progress/progress-statistics-model'
import { NOT_BEYOND_DRIFT, DRIFT_UNMEASURED, firstClearText, gainText, graderAloneRaises, LIVE_SCORES, MEASURED_TWICE, NO_VERDICT, NOT_EVIDENCE, priorBlindText, PROGRESS_LINK_TEXT, sharedPriorBlindText, stripScoresLabel } from './mastery-progress-strip-model'

// The view's module imports the RPC client, which reads Vite's import.meta.env; the view itself never calls it.
mock.module('../../lib/api', () => ({ useRpcQuery: () => ({}) }))
const { MasteryProgressStripView } = await import('./MasteryProgressStrip')

type Progress = RpcOutput<'getMasteryProgress'>
type Changes = RpcOutput<'getMasteryChanges'>
type W = Partial<Progress['windows'][number]> & { window: '24h' | '7d' | '30d' }

const progress = (windows: W[], over: Partial<Progress> = {}): Progress => ({
  scores: 'live', liveRisePerGrading: 2.146, gainsWithheldForDrift: false, due: 3,
  windows: windows.map((w) => ({ beforePercent: 20, nowPercent: 40.5, up: 0, firstClear: 0, compared: 0, withheldForDrift: 0, ...w })),
  ...over,
})
const html = (p: Progress) => renderToStaticMarkup(<MemoryRouter><MasteryProgressStripView progress={p} /></MemoryRouter>)
/** The element carrying `data-testid`: its tag, open-tag attributes and inner HTML (nesting-aware); null when absent. */
const element = (markup: string, id: string) => {
  const open = markup.match(new RegExp(`<(\\w+)([^>]*data-testid="${id}"[^>]*)>`))
  if (!open) return null
  const tag = open[1]!, start = open.index! + open[0].length
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g')
  re.lastIndex = start
  for (let depth = 1, m; (m = re.exec(markup));) if ((depth += m[1] ? -1 : 1) === 0) return { tag, attrs: open[2]!, inner: markup.slice(start, m.index) }
  throw new Error(`unclosed ${tag}`)
}
const text = (inner: string) => inner.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&')
const COLOUR = /emerald|rose|amber|success|danger|warning|text-accent|green|red/
const three = (w: Omit<W, 'window'>) => (['24h', '7d', '30d'] as const).map((window) => ({ window, up: 0, compared: 0, withheldForDrift: 0, ...w }))

describe('Osmosis Map progress strip (review round 3 B2; strip review B1, S1-S3, N1-N3)', () => {
  test('names the grader its before → now figures come from, in the Progress page\'s own words', () => {
    const label = stripScoresLabel({ scores: 'live', liveRisePerGrading: 2.146 })
    expect(label).toBe(`Before → now are the live grader’s scores: ${LIVE_SCORES}, and ${graderAloneRaises(2.146)}, ${NOT_EVIDENCE}.`)
    expect(label).toContain('+2.1 points per grading')
    expect(stripScoresLabel({ scores: 'live', liveRisePerGrading: null })).toBe(`Before → now are the live grader’s scores: ${LIVE_SCORES}, ${NOT_EVIDENCE}.`)
    // The shared phrases are the page's, not a parallel wording: the page's own lines contain them.
    const page = { anchored: { meanChange: 9.2, meanGradingsBetween: 4.1, nConcepts: 87, expectedFromDrift: 8.8 }, noise: { drift: { meanMove: 2.146 } }, aggregate: { meanChange: null } } as unknown as Changes
    const anchored = anchoredLine(page)!
    for (const phrase of [LIVE_SCORES, graderAloneRaises(2.146), NOT_EVIDENCE]) expect(anchored).toContain(phrase)
    expect(changeLine(page)).toContain(MEASURED_TWICE)
  })

  test('prior-blind line: drift withholds every verdict; nothing compared is "no verdict yet"; no ▲ is "no rise", never "no change" (S1)', () => {
    expect(priorBlindText({ withheldForDrift: 0, up: 3, compared: 60 }, true)).toBe(`${NO_VERDICT} (${DRIFT_UNMEASURED})`)
    expect(priorBlindText({ withheldForDrift: 0, up: 0, compared: 60 }, true)).toBe('prior-blind: no verdict yet (grader drift not measured)')
    expect(priorBlindText({ withheldForDrift: 0, up: 0, compared: 0 }, false)).toBe(`prior-blind: no verdict yet (no concept ${MEASURED_TWICE})`)
    expect(priorBlindText({ withheldForDrift: 0, up: 0, compared: 2 }, false)).toBe(`prior-blind: no rise beyond grader noise (2 concepts ${MEASURED_TWICE})`)
    expect(priorBlindText({ withheldForDrift: 0, up: 0, compared: 2 }, false)).not.toContain('no change')
    expect(priorBlindText({ withheldForDrift: 0, up: 1, compared: 2 }, false)).toBeNull()
    expect(gainText(3, 60)).toBe('3 of 60 rose beyond grader noise (prior-blind)')
    expect(firstClearText(1)).toBe('1 first clear reading (live grader)')
    expect(firstClearText(2)).toBe('2 first clear readings (live grader)')
    expect(sharedPriorBlindText(three({ compared: 0 }), false)).toBe(priorBlindText({ withheldForDrift: 0, up: 0, compared: 0 }, false))
    expect(sharedPriorBlindText([{ withheldForDrift: 0, up: 0, compared: 0 }, { withheldForDrift: 0, up: 0, compared: 1 }], false)).toBeNull()
    expect(sharedPriorBlindText([{ withheldForDrift: 0, up: 1, compared: 1 }, { withheldForDrift: 0, up: 1, compared: 1 }], false)).toBeNull()
  })

  test('rendered: the label names its grader and links to the prior-blind statistics, with or without a measured rise (S3: V7, V8)', () => {
    for (const rise of [2.146, null]) {
      const markup = html(progress(three({}), { liveRisePerGrading: rise }))
      expect(text(element(markup, 'mastery-scores-label')!.inner)).toBe(stripScoresLabel({ scores: 'live', liveRisePerGrading: rise }))
      const link = element(markup, 'mastery-progress-link')!
      expect(link.tag).toBe('a')
      expect(link.attrs).toContain('href="/learner/progress"')
      expect(text(link.inner)).toBe(PROGRESS_LINK_TEXT)
    }
  })

  test('rendered: the live before → now is a bare figure, no colour, sign, marker or words (S3: V4, V6)', () => {
    const markup = html(progress([{ window: '24h' }, { window: '7d', up: 1, compared: 2, firstClear: 1 }, { window: '30d', beforePercent: 50, nowPercent: 7 }]))
    for (const [w, want] of [['24h', '20% → 40.5%'], ['7d', '20% → 40.5%'], ['30d', '50% → 7%']] as const) {
      const cell = element(markup, `mastery-live-${w}`)!
      expect(text(cell.inner)).toBe(want)
      expect(text(cell.inner)).toMatch(/^\d+(\.\d)?% → \d+(\.\d)?%$/)
      expect(cell.attrs).not.toMatch(COLOUR)
    }
  })

  test('rendered: an anchored-only first clear is plain text, never a ▲ or a coloured badge (S3: V3)', () => {
    const markup = html(progress(three({ firstClear: 2 })))
    expect(markup).not.toContain('▲')
    expect(markup).not.toContain('mastery-up-')
    const first = element(markup, 'mastery-first-clear-24h')!
    expect(text(first.inner)).toBe(firstClearText(2))
    expect(first.attrs).not.toMatch(COLOUR)
    expect(first.attrs).not.toMatch(/rounded-full|border/)
  })

  test('rendered: a prior-blind gain is the one ▲, with its denominator, the glyph hidden from screen readers (S2, N3)', () => {
    const markup = html(progress([{ window: '24h' }, { window: '7d', up: 1, compared: 2, firstClear: 1 }, { window: '30d', compared: 3 }]))
    const up = element(markup, 'mastery-up-7d')!
    expect(text(up.inner)).toBe(`▲ ${gainText(1, 2)}`)
    expect(up.inner).toContain('<span aria-hidden="true">▲ </span>')
    expect(up.attrs).not.toContain('title=')
    expect(up.attrs).not.toMatch(/truncate|nowrap/)
    expect(markup.match(/▲/g)?.length).toBe(1)
    expect(element(markup, 'mastery-prior-blind-7d')).toBeNull()
    expect(text(element(markup, 'mastery-prior-blind-24h')!.inner)).toBe(priorBlindText({ withheldForDrift: 0, up: 0, compared: 0 }, false)!)
    expect(text(element(markup, 'mastery-prior-blind-30d')!.inner)).toBe(priorBlindText({ withheldForDrift: 0, up: 0, compared: 3 }, false)!)
    expect(element(markup, 'mastery-prior-blind-all')).toBeNull()
  })

  test('rendered: while the server withholds gains for drift, no ▲ anywhere and the strip says why (B1)', () => {
    const markup = html(progress([{ window: '24h', up: 1, compared: 1 }, { window: '7d', up: 3, compared: 60 }, { window: '30d', up: 3, compared: 60 }], { gainsWithheldForDrift: true }))
    expect(markup).not.toContain('▲')
    expect(markup).not.toContain('mastery-up-')
    expect(text(element(markup, 'mastery-prior-blind-all')!.inner)).toBe('24h · 7d · 30d: prior-blind: no verdict yet (grader drift not measured)')
  })

  test('rendered: the same prior-blind line in every window is said once for the strip (N1)', () => {
    const markup = html(progress(three({})))
    expect(text(element(markup, 'mastery-prior-blind-all')!.inner)).toBe(`24h · 7d · 30d: ${priorBlindText({ withheldForDrift: 0, up: 0, compared: 0 }, false)}`)
    expect(markup).not.toContain('mastery-prior-blind-24h')
  })

  test('drift-withheld rises (server blindGain): counted while drift is unmeasured, named beside or instead of a ▲ once it is', () => {
    expect(priorBlindText({ up: 0, compared: 60, withheldForDrift: 2 }, true)).toBe(`${NO_VERDICT} for 2 rises beyond grader noise (${DRIFT_UNMEASURED})`)
    expect(priorBlindText({ up: 0, compared: 60, withheldForDrift: 1 }, false)).toBe(`${NO_VERDICT} for 1 rise beyond grader noise (${NOT_BEYOND_DRIFT})`)
    // A window whose rises cleared noise but not drift is NOT "no rise beyond grader noise".
    expect(priorBlindText({ up: 0, compared: 60, withheldForDrift: 1 }, false)).not.toContain('no rise')
    expect(priorBlindText({ up: 3, compared: 60, withheldForDrift: 1 }, false)).toBe(`${NO_VERDICT} for 1 rise beyond grader noise (${NOT_BEYOND_DRIFT})`)
    const page = { aggregate: { meanChange: 3, changeInterval: { low: 0.5, high: 5 }, nConcepts: 87, minimumConcepts: 20, withheldForDrift: true, withheldForRevision: false, drift: { perWeek: 0.2, interval: { low: -0.3, high: 0.7 }, spanWeeks: 6, expected: { low: -1.8, high: 4.2 } }, conclusive: false } } as unknown as Changes
    expect(changeLine(page)).toContain(NOT_BEYOND_DRIFT)
    const markup = html(progress([{ window: '24h' }, { window: '7d', up: 3, compared: 60, withheldForDrift: 1 }, { window: '30d', compared: 60, withheldForDrift: 2 }]))
    expect(text(element(markup, 'mastery-up-7d')!.inner)).toBe(`▲ ${gainText(3, 60)}`)
    expect(text(element(markup, 'mastery-prior-blind-7d')!.inner)).toBe(priorBlindText({ up: 3, compared: 60, withheldForDrift: 1 }, false)!)
    expect(element(markup, 'mastery-up-30d')).toBeNull()
    expect(text(element(markup, 'mastery-prior-blind-30d')!.inner)).toBe(priorBlindText({ up: 0, compared: 60, withheldForDrift: 2 }, false)!)
    expect(element(markup, 'mastery-prior-blind-all')).toBeNull()
    expect(markup.match(/▲/g)?.length).toBe(1)
  })
})
