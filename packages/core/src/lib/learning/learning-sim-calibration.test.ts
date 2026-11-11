import { describe, expect, test } from 'bun:test'
import { CALIBRATION_CONCEPTS, CALIBRATION_DOSES, DOSE_SESSIONS, calibrationCalls, calibrationExam, doseOf, summarizeCalibration, type CalibrationReplicate } from './learning-sim-calibration.js'

describe('simulated learner calibration', () => {
  test('four replicates put every concept at every dose once (a Latin square)', () => {
    for (const [i] of CALIBRATION_CONCEPTS.entries()) expect([0, 1, 2, 3].map((r) => doseOf(r, i)).sort()).toEqual([...CALIBRATION_DOSES].sort())
    for (const r of [0, 1, 2, 3]) expect(CALIBRATION_CONCEPTS.map((_, i) => doseOf(r, i)).sort()).toEqual([...CALIBRATION_DOSES].sort())
  })

  test('a dose is that many explanations, all ending in the last session', () => {
    for (const dose of CALIBRATION_DOSES) {
      expect(DOSE_SESSIONS[dose]!.length).toBe(dose)
      if (dose) expect(DOSE_SESSIONS[dose]!.at(-1)).toBe(4)
    }
    expect(calibrationExam().length).toBe(3 * CALIBRATION_CONCEPTS.length)
    expect(calibrationCalls(4)).toEqual({ perReplicate: 7 + 4 + 10, ceiling: 3, total: 87 })
  })

  test('summarizes the final exam by dose and flags a non-monotone response', () => {
    const rep = (replicate: number, final: number[]): CalibrationReplicate => ({ replicate,
      doses: Object.fromEntries(CALIBRATION_CONCEPTS.map((id, i) => [id, doseOf(replicate, i)])),
      exams: [0, 1, 2, 3, 4].map((t) => ({ replicate, timepoint: t, points: {}, byConcept: Object.fromEntries(CALIBRATION_CONCEPTS.map((id, i) => [id, t === 4 ? final[doseOf(replicate, i) === 0 ? 0 : doseOf(replicate, i) === 1 ? 1 : doseOf(replicate, i) === 2 ? 2 : 3]! : 0])) })),
      notebooks: [] })
    const ok = summarizeCalibration([rep(0, [0, 40, 60, 90]), rep(1, [10, 50, 70, 80])])
    expect(ok.finalByDose[0]!.mean).toBe(5)
    expect(ok.finalByDose[4]!.mean).toBe(85)
    expect(ok.monotone).toBe(true)
    expect(summarizeCalibration([rep(0, [0, 60, 40, 90])]).monotone).toBe(false)
  })
})
