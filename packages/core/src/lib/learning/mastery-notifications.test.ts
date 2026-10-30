import { expect, test } from 'bun:test'
import { coachBaseline, coachTargetPerArm, COACH_ARMS, daysLeft } from './mastery-notifications.js'

test('coach target per arm: ceil(7.84 × (p0(1−p0) + p1(1−p1)) / d²) with p1 = p0 − 0.10', () => {
  // p0 0.35, p1 0.25: 7.84 × (0.2275 + 0.1875) / 0.01 = 325.36
  expect(coachTargetPerArm(0.35)).toBe(326)
  expect(coachTargetPerArm(0.5)).toBe(Math.ceil(7.84 * (0.25 + 0.24) / 0.01))
  expect(coachTargetPerArm(0.05)).toBe(Math.ceil(7.84 * (0.05 * 0.95) / 0.01))
})

test('coach baseline: the prior 0.35 until the baseline arm has 50 rows, then its measured breach rate', () => {
  const prior = coachBaseline([{ arm: 'baseline', rows: 49, breaches30: 49, rowsLast14Days: 49 }])
  expect(prior).toMatchObject({ baselineBreachRate: 0.35, baselineRateMeasured: false })
  const measured = coachBaseline([{ arm: 'baseline', rows: 100, breaches30: 20, rowsLast14Days: 0 }])
  expect(measured).toMatchObject({ baselineBreachRate: 0.2, baselineRateMeasured: true })
  expect(measured.arms[0]!.need).toBe(coachTargetPerArm(0.2))
})

test('coach baseline: every arm is listed, an arm with no rows is the slowest, and pace is the 14-day turns ÷ 14 ÷ 4', () => {
  const b = coachBaseline([
    { arm: 'baseline', rows: 200, breaches30: 70, rowsLast14Days: 140 },
    { arm: 'caw_audio', rows: 100, breaches30: 30, rowsLast14Days: 84 },
  ])
  expect(b.arms.map((a) => a.arm)).toEqual([...COACH_ARMS])
  expect(b.arms.find((a) => a.arm === 'pavlok_shock')!.have).toBe(0)
  expect(b.pacePerArmPerDay).toBeCloseTo(224 / 14 / 4)
  expect(b.daysLeft).toBe(Math.ceil(coachTargetPerArm(0.35) / (224 / 14 / 4)))
  expect(coachBaseline([]).daysLeft).toBeNull()
})

test('daysLeft: zero when done, null without 3 days of data or a pace', () => {
  expect(daysLeft(0, 0, 0)).toBe(0)
  expect(daysLeft(5, 1, 2)).toBeNull()
  expect(daysLeft(5, 0, 10)).toBeNull()
  expect(daysLeft(5, 2, 3)).toBe(3)
})
