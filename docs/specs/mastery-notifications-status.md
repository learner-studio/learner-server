# Mastery notifications MVP: learner-server status

Brief: [mastery-notifications.md](mastery-notifications.md). The channel of record for this repo's progress: the loop updates it every iteration.

States: todo / building / review / accepted / blocked. An AC is accepted only with evidence and a fresh-context adversarial review that found nothing.

## Contract

Commit with S2–S4 (for learner-desktop D1 to pin): **`02fec3f400a652c19521364efe7372fd61667f07`** (2026-10-30). Shapes: `packages/contract/src/learning/mastery.ts`; `packages/contract/contract.json` (51 RPCs).

- `getMasteryNotifications({ since: ISO | null, limit = 20 (1–100) })` → `{ notifications: [{ runId, conceptId, conceptName, kind: first_clear | gain, percent, previousPercent | null, delta (≥ 0) | null, confidence: medium | high, completedAt, quote | null }] }`, newest first. `since` is exclusive; the client keeps the cursor (newest `completedAt` seen).
- `getBaselineStatus({})` → `{ learning: { have, need, pacePerDay, daysLeft | null }, coach: { arms: [{ arm, have, need }], baselineBreachRate, baselineRateMeasured, pacePerArmPerDay, daysLeft | null } | null }`.
- `recordNotificationFeedback({ runId, action: opened | nice | not_right | ignored })` → `{ recorded, at }`; idempotent per (run, action).
- Auth: a device key (scope `app`) reads the learner's mastery (the first `LEARNER_ADMIN_EMAILS` account); an admin session reads its own.

## Owner decisions (2026-10-30)

- (a) S3 coach filter accepted as built (eligible, not simulated, call category, no synthetic sessions, confirmed_speech_span_v1).
- (b) S0 gates 2–4 are reported, not blocking; labelling the 20 gains is Ben's follow-up.
- (c) S7 accepted with GrowthBook's own checks on; the alert delivery channel is pending Ben, not a blocker.
- (d) J2 is accepted when Ben clicks Open on a live toast or on learner-desktop's recent-gains tray row, and the server confirms the `opened` row and the landing.
- The coordinator session is retired; learner-desktop is the only peer.

## Acceptance criteria

| AC | State | Evidence | Last updated |
|---|---|---|---|
| S0 Replay on real data | review | `scripts/mastery-replay.ts` (read-only pools, no model calls; exit 1 if gate 1 fails). Run 2026-10-30 on dev, numbers below. Gate 1 PASS. | 2026-10-30 |
| S1 Migration | review | 0015 (02fec3f) + 0016 (1f96f44) applied on learner_test and dev. View = manual runs + last assessed part of a finished live vector-turn pass; experimentId from the run digest (26 s → 0.26 s). 0016: completedAt = when the reading went live (pass finish), `reused_run_id` exposed. Review round 1: 2 blocking + 3 should-fix, fixed in 1f96f44; round 2 running. | 2026-10-30 |
| S2 `getMasteryNotifications` | review | 1f96f44 + 68e99c9. 0017: completedAt at millisecond precision (the JSON precision), so a cursor taken from a sent completedAt always advances; found by learner-desktop and review round 2, regression test added; live walk of the real API at limit 1: 37/37, no repeats. Integration: first clear, +10 over best earlier counted reading, low ignored, dip recovery not announced, first clear carries no previous/delta, cursor paging never skips or splits a tie, other learner empty. Dev: 37 notifications, ~420 ms. Known and absorbed: two passes committing out of order can put an earlier completedAt behind a cursor; the desktop's 15-min reach-back + runId dedupe covers it. | 2026-10-30 |
| S3 `getBaselineStatus` | review | 1f96f44. One reading per origin (unchanged copies and chains of them dropped). Unit: target n, prior until 50 rows, all 4 arms, pace ÷14 ÷4, daysLeft null < 3 days even when done. Dev: learning 83/1,155, 4.4/day, 243 days, 742 ms; coach 124/105/30/48 of 232, 39 days. Coach filter adds experiment_eligible / not simulated / call category / no synthetic sessions (what GrowthBook analyses): escalated to the coordinator for acceptance. | 2026-10-30 |
| S4 `recordNotificationFeedback` | review | 02fec3f. Integration: idempotent (same `at` on replay), another learner's run refused (recorded false). | 2026-10-30 |
| S5 Progress strip (web) | review | 68e99c9 + a0a0d2d. `getMasteryProgress` (curriculum mean of each concept's latest counted reading before → now for 24h/7d/30d; ▲ up = concepts with a gain or first clear; due = the live turn's review rule and scores, holdout excluded: dev 156, equal to the live rule) + `MasteryProgressStrip` above the tree and graph with the baseline line (all curricula); no decline markers; empty curriculum and baseline errors shown. `?conceptId=` opens the curriculum that holds the concept (`getLearningGraph` conceptId hint); an unknown one says "Concept not found". e2e `apps/web/e2e/mastery-progress.e2e.ts`: all checks pass (figures equal the server's, placement, deep link in and across curricula, unknown concept, no console errors). Screenshot `/var/lib/learner/e2e/osmosis-progress-strip.png` (mode 600). Review round 3: 4 should-fix, fixed in a0a0d2d. Round 4: no blocking; should-fix: the `conceptId` hint had no visibility test, added in a211464 (another learner's concept opens the default library, my own opens mine, an explicit curriculumId wins, unknown opens the default). Nits open: the notice text when the concept is in another visible curriculum while a curriculumId is set; the hint is read once at mount; the e2e second page skips console errors. The public URL is behind the Google login gate, so its live check is part of J2 (Ben's Open click). | 2026-10-30 |
| S6 Concept holdout | review | 0811a74. md5 bucket (1 in 5), SQL twin equals TS (all 1,155 concepts, 0 disagree); held-out ids are never task anchor, prerequisite or review (`learning-concept-holdout.test.ts`). Spaced-repetition replay passes an empty holdout (fixed fixture cases; review round 2: legitimate). Live 17:53Z, start 18:05Z. Replay (5) at 18:16Z: 4 live turns, 0 held-out concepts delivered as review or reported taught. Limit: delivered guidance conceptIds are not stored, so anchor/prerequisite exclusion is evidenced by the unit tests. | 2026-10-30 |
| S7 GrowthBook | review | Datasource `ds_learner_mastery` (read-only role `learner_growthbook`: SELECT on the view, learning_concepts, feedback; default_transaction_read_only; pg_hba 172.16/12 only; password in /etc/learner/growthbook-ro.env). Fact table `ftb_bkhj8zimvvaekoc` on the view (columns detected through the datasource). Assignment query `ex_concept_holdout` (SQL bucket = TS `isHeldOut` on all 1,155 concepts, 0 disagree). Metrics: best counted understanding (max), clear reading (proportion), guardrail any live reading. Experiment `exp_bkhj8zimvvaf8ar` running from 18:05Z, 80/20; first snapshot: 904 / 251 units, SRM p 0.14, 0 multiple exposures. Alerts: auto-update on (24 h stale schedule) so GrowthBook's SRM / significance / no-data / multiple-exposure checks run; NO delivery channel exists in this GrowthBook (0 event webhooks, no Slack): Ben to choose one. Coach: `exp_speech_coach_settings_v1` (running since 2026-09-12) already analyses only `confirmed_speech_span_v1`; the old mixed-timing experiment is stopped. Setup used a temporary admin API key, deleted after (401 now). | 2026-10-30 |
| S8 Live | review | gen-registry + `flock /run/learner/prepare.lock bun scripts/runtime.ts prepare` after each RPC/schema change; no env change, so no restart needed (api/worker restarted once at 17:53Z for the core holdout edit). The four RPCs answer live (401 without a key; device key reads the learner). `LEARNER_PORT=3019 bun run gate` at a0a0d2d (clean tree): passed on both runtimes (framework + standalone). | 2026-10-30 |
| J1 Contract parity | review | The three new RPC entries in the server's `contract.json` (HEAD) and learner-desktop's pinned `contract/contract.json` (02fec3f): 3 = 3 entries, identical (sha 3e2d2b57…). The server has one more RPC overall (52 vs 51): `getMasteryProgress`, web only. | 2026-10-30 |
| J2 Live end to end | building | Desktop build (main 182b022) polling on the Mac since 18:19Z, cursor 18:03:56Z. Manual runs did not qualify (quote validator; 25 % low; identical-evidence refusal; 3 concepts over the 400 KB input budget). Root blocker found: the canonical index had been stalled since 10-27 12:29Z (Hindsight 0.9.2 strips form feeds, so one chunk never verified; breaker at 3 attempts). Fixed in 6c3a8a9 (differential test against the vendored sanitizer; 29/32 → 32/32 on the stuck operation), lane retried 18:35Z: backlog of 15,181 messages indexed, 70+ live readings by 18:50Z, none notification-worthy yet. For the delivery chain against the real server: `pairing-server.ts --seed-mastery-gain` (0b86756) seeds one gain for a throwaway learner; --check proves fetch / cursor / idempotent feedback in both topologies; learner-desktop is building its opt-in e2e on it. learner-desktop's heavy e2e (MasteryE2ETests, opt-in) passed against it: real feed, toast, Open URL, feedback, no repeat after restart. **First organic toast:** gain c7bb7875 (20 → 30, medium, a generated personal-finance concept) live 18:59:17.537Z, toasted on the Mac 18:59:18Z (1 s); feedback row `ignored` at 18:59:27.844Z (no click in 8 s). Server side of the landing checked: the conceptId hint opens that curriculum, strip ▲ 1 up in 24h/7d/30d. Remaining: Open clicked on a live toast (landing + `opened` row). | 2026-10-30 |
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

Coach inputs (speech turns only, `confirmed_speech_span_v1`, eligible, not simulated, data quality ok): baseline 124 rows (30 s breach 23.4 %), caw_audio 105 (21.0 %), haptic_vibe 30 (40.0 %), pavlok_shock 48 (43.8 %). p0 = 0.234 measured, so n = 232 per arm; 5.2 turns per arm a day over 14 days; 39 days left (haptic_vibe is slowest). Learning (after 1f96f44, one reading per origin): 83/1,155 tracking, 4.4 new tracking concepts a day, 243 days left; new clear readings 1 in 14 days (0.07 a day).

## Log

- 2026-10-30: brief saved and status file created; loop started.
- 2026-10-30: correction to the brief's "Facts": `learning_reactive_admission.dispatch_id` is cleared once a pass settles (0 of 1,349 rows hold one), so it cannot identify reactive runs. Reactive = experimentId names a vector-turn pass with `config.purpose = 'live'` and `status = 'completed'`; unfinished passes never published (11 cache mismatches until that condition). Gate 1 on dev: 1,101/1,101 cache runs in the view, 1,101/1,101 latest readings equal.
- 2026-10-30: contract pushed (02fec3f); S1–S4 awaiting adversarial review.
- 2026-10-30: S6 pushed (0811a74) after the spaced-repetition replay went red (its anchor concept is held out); the live turn takes the holdout as a parameter defaulting to the live set, and the replay passes none.
- 2026-10-30: S1–S4 review round 1 (fresh context): blocking: unchanged copies counted as independent readings; coach filter stricter than the AC text (escalated). Should-fix: first_clear carried previousPercent; a `since` cursor could skip readings (newest-first + limit, and receipt time ≠ live time); daysLeft 0 with no data. All but the escalation fixed in 1f96f44; learner-desktop told about the paging semantics.
- 2026-10-30: review round 2: blocking, the since cursor could never pass a sub-millisecond completedAt (JSON carries ms); fixed in 0017 (68e99c9), learner-desktop found it independently. Replay gate 2 now uses the RPC's HISTORY. S5 built (68e99c9).
- 2026-10-30: S7 built in GrowthBook (ids in the table). Coach counts vs GrowthBook's own population: identical except haptic_vibe 30 vs 20 and pavlok 48 vs 47 (sessions whose settings changed mid-session); reported to the coordinator with the filter decision.
- 2026-10-30: review round 3 (S1/S2/S5): no blocking; should-fix: due used cache-only scores (155 vs live 156), empty curriculum loaded forever, a deep link outside the selected curriculum showed the wrong concept, the public URL is not tested (login gate: moved to J2). Fixed in a0a0d2d. Gate passed at a0a0d2d.
- 2026-10-30: review round 4 (S5): no blocking; visibility test for the deep-link hint added (a211464). The separation test caught this file naming the framework runtime; reworded. J2 started: run 2bb77a63 at 18:22:55Z.
- 2026-10-30: J2 blocker: the canonical semantic index stalled 10-27 12:29Z (no live passes, no readings for 3 days). Fixed in 6c3a8a9 and the lane retried once (retryLearningIndexAdmission); live readings flowing again. `--seed-mastery-gain` added to the pairing server (0b86756) for learner-desktop's real-server e2e.
- 2026-10-30: J2: first organic toast 1 s after the reading went live (c7bb7875); not clicked, so the Open → Map step waits for the next live gain.
- 2026-10-30: consumer review of learner-desktop (fresh context, 182b022): no blocking; 4 should-fix (cursor kept as a reformatted Date, web without a trailing slash, Open shown with no link, a non-retryable feedback reply jamming the queue) all fixed in learner-desktop c7a0c68; web is always a directory URL server-side too (6656a17). Contract unchanged, no re-pin.
- 2026-10-30: learner-desktop's review of this API (fresh context, 8052185): no blocking. Fixed: same-machine installs advertised `<api>/`, but the app routes only `/learner/…`, so a toast's deep link fell to the catch-all and lost conceptId; web is now `<api>/learner/` and LEARNER_WEB_URL must be `<origin>/learner` (pairing test + a deep-link assertion in `pairing-server.ts --check`). The device key's learner lookup is now case-insensitive, as auth.ts compares (integration test, red on the old code). Continuing a completed vector-turn pass is refused: reopening it unpublished its readings and could re-toast under a new run id (integration test, red on the old code). Not changed: a first clear reading has no percent floor and may sit below an earlier medium reading; the spec allows true values anywhere and it carries no delta (deliberate test). Whether to add a floor is Ben's call. Noted only: the view scans all users per call (~420 ms), the device key reads LEARNER_ADMIN_EMAILS[0] (single learner by design). Two duplicated integration tests removed.
