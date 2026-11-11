import { test, expect, describe } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { INJECTION_DRAW_SALT, injectionAllowed, injectionCoin, turnDraw } from './learning-intervention-policy.js'

/** Run a session where every turn has something worth teaching; return the injection pattern. */
const simulate = (rate: number, turns: number, valuable: (turn: number) => boolean = () => true) => {
  const injected: boolean[] = []
  for (let turn = 0; turn < turns; turn++) {
    const recent = [...injected].reverse()
    injected.push(valuable(turn) && injectionAllowed(recent, rate))
  }
  return injected
}

describe('injection rate is a ceiling over every 5 consecutive turns', () => {
  for (const rate of [0, 20, 40, 60, 80, 100]) {
    test(`${rate}%: realised rate equals the slider and no 5-turn window exceeds it`, () => {
      const injected = simulate(rate, 100)
      expect(injected.filter(Boolean).length).toBe(rate)
      for (let start = 0; start + 5 <= injected.length; start++)
        expect(injected.slice(start, start + 5).filter(Boolean).length).toBeLessThanOrEqual(rate / 20)
    })
  }
  test('a turn with nothing to teach spends no budget', () => {
    // 40%: odd turns have no value, so every valuable turn fits until the window fills.
    const injected = simulate(40, 10, (turn) => turn % 2 === 0)
    expect(injected.filter((_, turn) => turn % 2 === 1).some(Boolean)).toBe(false)
    expect(injected.filter(Boolean).length).toBe(4)
  })
  test('a fresh session starts with an injection when the rate is above zero', () => {
    expect(injectionAllowed([], 20)).toBe(true)
    expect(injectionAllowed([], 0)).toBe(false)
  })
  test('only the previous 4 turns count', () => {
    expect(injectionAllowed([false, false, false, false, true, true], 20)).toBe(true)
    expect(injectionAllowed([false, false, false, true], 20)).toBe(false)
  })
})

describe('randomized injection: a coin that is a pure function of the turn id', () => {
  const ids = Array.from({ length: 20_000 }, () => randomUUID())
  test('the same turn always draws the same number, and known ids draw known numbers', () => {
    for (const id of ids.slice(0, 200)) expect(turnDraw(INJECTION_DRAW_SALT, id)).toBe(turnDraw(INJECTION_DRAW_SALT, id))
    // Pinned so the assignment can never change silently (it would re-randomize stored turns).
    expect(turnDraw(INJECTION_DRAW_SALT, '00000000-0000-4000-8000-000000000000')).toBe(95)
    expect(turnDraw(INJECTION_DRAW_SALT, '58f302d6-a472-43bd-ad1e-58a0b4b85a3b')).toBe(80)
    // An uppercase id draws what Postgres computes for the stored (lowercase) uuid: 13 for this one in SQL.
    expect(turnDraw(INJECTION_DRAW_SALT, 'A390BD95-5074-4983-B270-B67944DC11DC')).toBe(13)
    expect(turnDraw(INJECTION_DRAW_SALT, 'a390bd95-5074-4983-b270-b67944dc11dc')).toBe(13)
    for (const id of ids.slice(0, 200)) { const d = turnDraw(INJECTION_DRAW_SALT, id); expect(Number.isInteger(d) && d >= 0 && d < 100).toBe(true) }
  })
  for (const rate of [0, 20, 40, 60, 80, 100]) {
    test(`${rate}%: the realised rate over 20,000 turn ids is the slider, within 1.5 points`, () => {
      const share = 100 * ids.filter((id) => injectionCoin(id, rate)).length / ids.length
      expect(Math.abs(share - rate)).toBeLessThan(1.5)
    })
  }
  test('raising the rate only adds turns: a turn injected at 40% is injected at 60%', () => {
    for (const id of ids.slice(0, 2000)) if (injectionCoin(id, 40)) expect(injectionCoin(id, 60)).toBe(true)
  })
  test('a different purpose draws independently of the injection coin', () => {
    const both = ids.filter((id) => turnDraw(INJECTION_DRAW_SALT, id) < 50 && turnDraw('another-purpose', id) < 50).length
    expect(Math.abs(100 * both / ids.length - 25)).toBeLessThan(1.5)
  })
})
