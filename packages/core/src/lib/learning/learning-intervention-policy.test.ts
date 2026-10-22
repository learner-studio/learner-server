import { test, expect, describe } from 'bun:test'
import { injectionAllowed } from './learning-intervention-policy.js'

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
