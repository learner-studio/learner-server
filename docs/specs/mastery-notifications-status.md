# Mastery notifications MVP: learner-server status

Brief: [mastery-notifications.md](mastery-notifications.md). The channel of record for this repo's progress: the loop updates it every iteration.

States: todo / building / review / accepted / blocked. An AC is accepted only with evidence and a fresh-context adversarial review that found nothing.

## Contract

Commit with S2–S4 (for learner-desktop D1 to pin): **`02fec3f400a652c19521364efe7372fd61667f07`** (2026-10-30). Shapes: `packages/contract/src/learning/mastery.ts`; `packages/contract/contract.json` (51 RPCs).

- `getMasteryNotifications({ since: ISO | null, limit = 20 (1–100) })` → `{ notifications: [{ runId, conceptId, conceptName, kind: first_clear | gain, percent, previousPercent | null, delta (≥ 0) | null, confidence: medium | high, completedAt, quote | null }] }`, newest first. `since` is exclusive; the client keeps the cursor (newest `completedAt` seen).
- `getBaselineStatus({})` → `{ learning: { have, need, pacePerDay, daysLeft | null }, coach: { arms: [{ arm, have, need }], baselineBreachRate, baselineRateMeasured, pacePerArmPerDay, daysLeft | null } | null }`.
- `recordNotificationFeedback({ runId, action: opened | nice | not_right | ignored })` → `{ recorded, at }`; idempotent per (run, action).
- Auth: a device key (scope `app`) reads the learner's mastery (the first `LEARNER_ADMIN_EMAILS` account); an admin session reads its own.

## Acceptance criteria

| AC | State | Evidence | Last updated |
|---|---|---|---|
| S0 Replay on real data | review | `scripts/mastery-replay.ts` (read-only pools, no model calls; exit 1 if gate 1 fails). Run 2026-10-30 on dev, numbers below. Gate 1 PASS. | 2026-10-30 |
| S1 Migration | review | 0015_mastery_notifications applied on learner_test and dev (02fec3f). View = manual runs + last assessed part of a finished live vector-turn pass; experimentId read from the run digest (new column), 26 s → 0.26 s. Tests: `mastery-notifications.integration.test.ts` (view keeps live only). | 2026-10-30 |
| S2 `getMasteryNotifications` | review | 02fec3f. Integration tests: first clear, +10 over best earlier counted reading, low ignored, dip recovery not announced, since exclusive, limit, other learner empty. Dev: 37 notifications, 260 ms. Live route answers 401 without a key. | 2026-10-30 |
| S3 `getBaselineStatus` | review | 02fec3f. Unit: target n (326 at p0 0.35), prior until 50 rows, all 4 arms, pace ÷14 ÷4. Integration: one high / two medium, low never, daysLeft null < 3 days. Dev: learning have 91 / need 1155, 5/day, 213 days, 600 ms. | 2026-10-30 |
| S4 `recordNotificationFeedback` | review | 02fec3f. Integration: idempotent (same `at` on replay), another learner's run refused (recorded false). | 2026-10-30 |
| S5 Progress strip (web) | todo | | 2026-10-30 |
| S6 Concept holdout | todo | | 2026-10-30 |
| S7 GrowthBook | todo | | 2026-10-30 |
| S8 Live | todo | | 2026-10-30 |
| J1 Contract parity | todo | | 2026-10-30 |
| J2 Live end to end | todo | | 2026-10-30 |
| J3 Adversarial review | todo | | 2026-10-30 |
| J4 Status files complete | todo | | 2026-10-30 |

## S0 replay numbers (dev, 2026-10-30)

`bun --env-file=/etc/learner/db.env scripts/mastery-replay.ts`

1. **View vs cache (blocking): PASS.** 1,101/1,101 cache runs in the view; 1,101/1,101 latest readings equal the cache.
2. **Per week** (live readings / medium-high / first clear / gains +5 / +10 / +15 over the best earlier medium/high reading):

   | Week | Readings | Medium/high | First clear | +5 | +10 | +15 |
   |---|---|---|---|---|---|---|
   | 2026-08-31 | 7 | 0 | 0 | 0 | 0 | 0 |
   | 2026-09-07 | 1,247 | 76 | 1 | 10 | 7 | 6 |
   | 2026-09-14 | 80 | 4 | 0 | 1 | 0 | 0 |
   | 2026-09-21 | 30 | 0 | 0 | 0 | 0 | 0 |
   | 2026-09-28 | 44 | 2 | 0 | 0 | 0 | 0 |
   | 2026-10-05 | 1 | 0 | 0 | 0 | 0 | 0 |
   | 2026-10-19 | 6,826 | 718 | 1 | 39 | 24 | 14 |
   | 2026-10-26 | 2,127 | 231 | 0 | 11 | 5 | 3 |

   At +10, about 5–24 notifications a week in active weeks. First clear readings are rare (2 in 8 weeks): only 1 of 1,101 cached estimates is high confidence.
3. **Grader spread** (same concept, identical evidence, same prompt revision, non-live runs): 1,003 groups, 2,819 gradings; spread p50 10 / p90 35 / max 60 points, mean sd 8.7. **63 % of groups spread ≥ 10 points**, so a +10 gain is often within grading noise. Reported for Ben's decision (gate 3 is not blocking); see the labelling file.
4. **20 recent gains with quotes:** `/var/lib/learner/mastery-replay/gains-2026-10-30.md` on the dev box (mode 600; the learner's own words, so not in this public repo). Labels pending from Ben.

Coach inputs (speech turns only, `confirmed_speech_span_v1`, eligible, not simulated, data quality ok): baseline 124 rows (30 s breach 23.4 %), caw_audio 105 (21.0 %), haptic_vibe 30 (40.0 %), pavlok_shock 48 (43.8 %). p0 = 0.234 measured, so n = 232 per arm; 5.2 turns per arm a day over 14 days; 39 days left (haptic_vibe is slowest). Learning: 91/1,155 tracking, 5.0 new tracking concepts a day, 213 days left; new clear readings 1 in 14 days (0.07 a day).

## Log

- 2026-10-30: brief saved and status file created; loop started.
- 2026-10-30: correction to the brief's "Facts": `learning_reactive_admission.dispatch_id` is cleared once a pass settles (0 of 1,349 rows hold one), so it cannot identify reactive runs. Reactive = experimentId names a vector-turn pass with `config.purpose = 'live'` and `status = 'completed'`; unfinished passes never published (11 cache mismatches until that condition). Gate 1 on dev: 1,101/1,101 cache runs in the view, 1,101/1,101 latest readings equal.
- 2026-10-30: contract pushed (02fec3f); S1–S4 awaiting adversarial review.
