import { describe, expect, test } from 'bun:test'
import { CALIBRATION_SESSIONS, CALIBRATION_CONCEPTS, CALIBRATION_DOSES, DOSE_SESSIONS, calibrationCalls, calibrationExam, doseOf, summarizeCalibration, type CalibrationReplicate } from './learning-sim-calibration.js'

describe('simulated learner calibration', () => {
  test('four replicates put every concept at every dose once (a Latin square)', () => {
    for (const [i] of CALIBRATION_CONCEPTS.entries()) expect([0, 1, 2, 3].map((r) => doseOf(r, i)).sort()).toEqual([...CALIBRATION_DOSES].sort())
    for (const r of [0, 1, 2, 3]) expect(CALIBRATION_CONCEPTS.map((_, i) => doseOf(r, i)).sort()).toEqual([...CALIBRATION_DOSES].sort())
  })

  test('a dose is that many explanations, one concept per session', () => {
    for (const dose of CALIBRATION_DOSES) {
      expect(DOSE_SESSIONS[dose]!.length).toBe(dose)
    }
    expect(CALIBRATION_SESSIONS).toBe(7)
    expect(calibrationExam().length).toBe(8 * CALIBRATION_CONCEPTS.length)
    expect(new Set(calibrationExam().map((x) => x.id)).size).toBe(32)
    expect(calibrationCalls(3, 4, { replies: false, examAt: [7] })).toEqual({ perReplicate: 7 + 2, ceiling: 0, total: 108 })
  })

  test('summarizes the final exam by dose and flags a non-monotone response', () => {
    const rep = (replicate: number, final: number[]): CalibrationReplicate => ({ lane: 'medium', replicate,
      doses: Object.fromEntries(CALIBRATION_CONCEPTS.map((id, i) => [id, doseOf(replicate, i)])),
      exams: [0, 1, 2, 3, 4, 5, 6, 7].map((t) => ({ replicate, timepoint: t, points: {}, byConcept: Object.fromEntries(CALIBRATION_CONCEPTS.map((id, i) => [id, t === 7 ? final[doseOf(replicate, i) === 0 ? 0 : doseOf(replicate, i) === 1 ? 1 : doseOf(replicate, i) === 2 ? 2 : 3]! : 0])) })),
      notebooks: [] })
    const ok = summarizeCalibration([rep(0, [0, 40, 60, 90]), rep(1, [10, 50, 70, 80])]).medium!
    expect(ok.finalByDose[0]!.mean).toBe(5)
    expect(ok.finalByDose[4]!.mean).toBe(85)
    expect(ok.monotone).toBe(true)
    expect(summarizeCalibration([rep(0, [0, 60, 40, 90])]).medium!.monotone).toBe(false)
  })
})
