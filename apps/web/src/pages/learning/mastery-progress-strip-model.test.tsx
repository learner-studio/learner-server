import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RpcOutput } from '@learner/contract'
import { anchoredLine, changeLine, VERDICT_NONE, VERDICT_ROSE } from '../progress/progress-statistics-model'
import { firstClearText, gainBadge, graderAloneRaises, LIVE_SCORES, MEASURED_TWICE, NOT_EVIDENCE, priorBlindText, stripScoresLabel } from './mastery-progress-strip-model'

// The view's module imports the RPC client, which reads Vite's import.meta.env; the view itself never calls it.
mock.module('../../lib/api', () => ({ useRpcQuery: () => ({}) }))
const { MasteryProgressStripView } = await import('./MasteryProgressStrip')

type Progress = RpcOutput<'getMasteryProgress'>
type Changes = RpcOutput<'getMasteryChanges'>

const progress = (windows: Array<Partial<Progress['windows'][number]> & { window: '24h' | '7d' | '30d' }>, rise: number | null = 2.146): Progress => ({
  scores: 'live', liveRisePerGrading: rise, due: 3,
  windows: windows.map((w) => ({ beforePercent: 20, nowPercent: 40, up: 0, firstClear: 0, compared: 0, ...w })),
})
const html = (p: Progress) => renderToStaticMarkup(<MasteryProgressStripView progress={p} />)
/** The inner HTML of the element carrying `data-testid` (attribute order agnostic), '' when absent. */
const byTestId = (markup: string, id: string) => markup.match(new RegExp(`<(\\w+)[^>]*data-testid="${id}"[^>]*>(.*?)</\\1>`))?.[2] ?? ''

describe('Osmosis Map progress strip (review round 3, B2)', () => {
  test('names the grader its before → now figures come from, in the Progress page\'s own words', () => {
    const label = stripScoresLabel({ scores: 'live', liveRisePerGrading: 2.146 })
    expect(label).toContain('live grader')
    expect(label).toContain(LIVE_SCORES)
    expect(label).toContain(graderAloneRaises(2.146))
    expect(label).toContain('+2.1 points per grading')
    expect(label).toContain(NOT_EVIDENCE)
    expect(stripScoresLabel({ scores: 'live', liveRisePerGrading: null })).toContain(NOT_EVIDENCE)
    // The shared phrases are the page's, not a parallel wording: the page's own lines contain them.
    const page = { anchored: { meanChange: 9.2, meanGradingsBetween: 4.1, nConcepts: 87, expectedFromDrift: 8.8 }, noise: { drift: { meanMove: 2.146 } }, aggregate: { meanChange: null } } as unknown as Changes
    const anchored = anchoredLine(page)!
    for (const phrase of [LIVE_SCORES, graderAloneRaises(2.146), NOT_EVIDENCE]) expect(anchored).toContain(phrase)
    expect(changeLine(page)).toContain(MEASURED_TWICE)
  })

  test('the ▲ is a prior-blind rise beyond noise; a first clear reading is the live grader\'s and carries no ▲', () => {
    expect(gainBadge(3)).toBe('▲ 3 rose beyond grader noise (prior-blind; grader drift not tested)')
    expect(firstClearText(1)).toBe('1 first clear reading (live grader)')
    expect(firstClearText(2)).toBe('2 first clear readings (live grader)')
    expect(firstClearText(2)).not.toContain('▲')
  })

  test('prior-blind line: no verdict yet when nothing was measured twice, the page\'s "not distinguishable" otherwise, none beside a ▲', () => {
    expect(priorBlindText({ up: 0, compared: 0 })).toBe(`prior-blind: no verdict yet (no concept ${MEASURED_TWICE})`)
    expect(priorBlindText({ up: 0, compared: 2 })).toBe(`prior-blind: ${VERDICT_NONE} (2 concepts ${MEASURED_TWICE})`)
    expect(priorBlindText({ up: 1, compared: 2 })).toBeNull()
  })

  test('rendered: an anchored-only first clear is not a gain (no ▲, no success badge), and the strip names its grader', () => {
    const markup = html(progress([{ window: '24h', firstClear: 2 }, { window: '7d', firstClear: 2 }, { window: '30d', firstClear: 2 }]))
    expect(markup).not.toContain('▲')
    expect(markup).not.toContain('mastery-up-')
    expect(byTestId(markup, 'mastery-first-clear-24h')).toBe(firstClearText(2))
    expect(byTestId(markup, 'mastery-prior-blind-24h')).toBe(priorBlindText({ up: 0, compared: 0 })!)
    expect(byTestId(markup, 'mastery-scores-label')).toBe(stripScoresLabel({ scores: 'live', liveRisePerGrading: 2.146 }))
  })

  test('rendered: a prior-blind gain is the one ▲, with the page\'s verdict as its title', () => {
    const markup = html(progress([{ window: '24h' }, { window: '7d', up: 1, compared: 2, firstClear: 1 }, { window: '30d', compared: 3 }]))
    expect(byTestId(markup, 'mastery-up-7d')).toBe(gainBadge(1))
    expect(markup.match(/▲/g)?.length).toBe(1)
    expect(markup).toContain(`title="Prior-blind grader: ${VERDICT_ROSE}"`)
    expect(byTestId(markup, 'mastery-prior-blind-7d')).toBe('')
    expect(byTestId(markup, 'mastery-prior-blind-30d')).toBe(priorBlindText({ up: 0, compared: 3 })!)
  })
})
