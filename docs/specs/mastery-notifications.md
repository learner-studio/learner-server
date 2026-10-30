# Mastery notifications MVP: build brief and acceptance criteria

From: Ben, through the coordinating session `session_01BysNdGEv3M6N8KVsvGP3vC` ("Mastery notification UI prototype"). Ben's instruction, verbatim: "send learner-desktop and learner-server agents this spec and coordinate with both of them. have learner-server go into a loop using the "/loop" command and make sure that it is building this and testing this until all of the acceptance criteria are accepted from the backend and front end and that it has been tested on the front end through the website and that there has been an adversarial review against the acceptance criteria. in parallel initiate a loop for the learner-desktop agent to build and iterate the same thing until it's done according to spec and they are in sync. minimal self-healing durable workflows, and adversarial reviews required." He wants a final status only when the work is done, live, tested live in both codebases, and both agents and the coordinator have given the okay.

This file is the brief from now on. The loop re-reads it every iteration. Corrections from the coordinator are applied here. Status: [mastery-notifications-status.md](mastery-notifications-status.md).

Roles: this repo (learner-server) owns S0–S8 and J1–J4. learner-desktop (session `session_01BysNdGNctLWCmFesdyuB2X`, on Ben's Mac) builds D1–D8 in parallel and pins this repo's contract.

## Reference

Private claude.ai pages: they open only signed in as Ben, e.g. with an Artifact tool. This brief is self-contained without them.

- MVP (what to build): [Mastery Notifications MVP](https://claude.ai/artifact/JyeKUWwJi4znSy5rHu39bJ)
- Full spec (the longer-term target; only the MVP is in scope): [Mastery Notifications Spec](https://claude.ai/artifact/JN9EHaKpzAs9c1Emvea7KH)
- Web prototype (look of the progress strip): [Learner Map Mastery](https://claude.ai/artifact/66z93j8mFX9AekN4yCcY3U)
- Desktop prototype (tray lines, toast, call hold): [Learner Desktop Mastery](https://claude.ai/artifact/SxnUum4P3Yaef6piboFRkv)

## Scope

The MVP plus one web piece: the progress strip on the Osmosis Map. Decisions already made by Ben:

- **Positive only.** Progress updates (toasts, tray rows, strip counts) report gains only, never decreases. True values may show anywhere (a concept at 70% after 75% reads 70%), but no update ever announces a drop. Declines are still measured on the back end.
- **No daily digest.** Rejected: rollups are typically annoying; incremental progress belongs in the progress strip. No cadence setting.
- **Baseline display A** (always visible lines). No milestone notifications, no A/B switch.
- A concept's **baseline** is set by one clear (high-confidence) reading, or two medium ones. Low never counts. Keep both as named constants.
- **Out of scope:** web bell/tray, graph rings, tile chips, progress panel, inspector timeline, efficacy notifications and `receiveGrowthBookEvent`, heartbeat `notificationsVersion`, server-side notification settings.

## Facts from the code (verify, do not trust blindly)

- History already exists: every finished assessment run's receipt stores `assessment.understandingPercent`, `assessment.confidence` and `completedAt` (`learning_concept_assessment_receipts` join `learning_concept_assessment_runs`). The incremental merge only combines demonstration lists. So history is a VIEW, not a new table.
- Live-only filter (my reading of the code; AC S1 proves or corrects it): manual runs have no `snapshot->>'experimentId'`; reactive runs set it to their dispatch id (`learning_reactive_admission.dispatch_id`); everything else is an experiment.
- `due()` in `learning-concept-assessment.ts` has no caller; passive readings come from reactive consolidation (`learningReactiveConsolidation`, gated by `enabled` and `assessmentEnabled`).
- The policy's `excluded` set only filters the review queue (`reviewQueue`); a holdout also needs a filter where the turn's main lesson concepts are chosen.
- The coach GrowthBook experiment `exp_3pqkl2kbmtry3gcv` mixes timing versions; count only `metadata.timing_version = 'confirmed_speech_span_v1'`, non-suspect rows.

## Acceptance criteria

Each AC is accepted only with evidence (commit SHA, test name and result, query output, or screenshot path) AND after a fresh-context adversarial reviewer failed to falsify it (see Loop rules).

### learner-server (S)

- **S0 Replay on real data.** `scripts/mastery-replay.ts`, read-only, no model calls. Prints: (1) view vs cache: every cache row's run is in the view and the latest reading per concept equals the cache (must be 100%, else fix the view); (2) per week for 8 weeks: live readings, first clear readings, gains of +5/+10/+15 at medium or high confidence; (3) spread of repeated gradings of the same concept in comparison/experiment runs; (4) 20 recent qualifying gains with quotes, written to a file for Ben to label real/not real; plus coach inputs (current-version rows per arm, measured 30 s breach rate, 14-day pace of new clear readings). Numbers recorded in the status file. Gates 2 to 4 are reported, not blocking; gate 1 blocks.
- **S1 Migration.** View `learning_mastery_readings` (live-only) and table `learning_notification_feedback(run_id, action, at)` with a unique (run_id, action). Migrates on `learner_test` and the dev DB.
- **S2 `getMasteryNotifications({ since, limit })`.** Returns first clear readings and gains of at least +10 (constant) at medium or high confidence, completed after `since`, newest first, keyed by run id, never a negative delta. Works with the device key (desktop) and an admin session (web). In `packages/contract/src/rpc.ts`; `contract-coverage.test.ts` passes; `bun run contract:json` regenerated.
- **S3 `getBaselineStatus()`.** Learning: have/need over concepts with any exposure, tracking per the baseline rule, pace = new tracking concepts per day over 14 days, `daysLeft` null when fewer than 3 days of data. Coach: per-arm current-version non-suspect counts from `habits`, speech turns only (`habit_type = 'monologue_streak'`; the same table holds `pavlok_intervention` rows with 0-second turn lengths, which must not count), per-arm target n = ceil(7.84 × (p0(1−p0) + p1(1−p1)) / d²) with d = 0.10 and p0 measured from the baseline arm (0.35 until it has 50 rows), `daysLeft` from the slowest arm at the 14-day turn pace ÷ 4.
- **S4 `recordNotificationFeedback({ runId, action })`.** action ∈ opened, nice, not_right, ignored; idempotent.
- **S5 Progress strip (web front end).** On the Osmosis Map (`LearningPage.tsx`), above the tree and graph: curriculum before → now % for 24h / 7d / 30d, "▲ N up" (gains only), "N due for review", and the learning baseline line (have/need, days left or "estimating your pace"). No decline markers. Playwright e2e in `apps/web/e2e`. Tested live on dev.biztoolz.app/learner/osmosis with a saved screenshot.
- **S6 Concept holdout.** `osmosis-concept-holdout`: one in five concepts by hash; excluded from the review queue AND from the turn's main lesson; a query shows no held-out concept in `taughtConceptIds` after the start time. Unit tests for both filters.
- **S7 GrowthBook.** A read-only datasource on the learner DB, a fact table on the view, an assignment query for the holdout, the experiment created, GrowthBook's own alert turned on; the coach experiment gets a phase filtered to the current timing version. If you lack GrowthBook admin access, record the exact blocker and move on.
- **S8 Live.** On dev.biztoolz.app: `bun scripts/gen-registry.ts`, the framework runtime `prepare` (`bun scripts/runtime.ts prepare`) under `flock /run/learner/prepare.lock`, restart only if env changed; the three RPCs answer live; `bun run gate` passes.

### learner-desktop (D)

- **D1** Contract pinned to the learner-server commit that has S2 to S4; `contract/PINNED_COMMIT` and `contract/contract.json` updated; `ContractTests` pass.
- **D2 Feed job.** `Mastery.swift`: a `Job` every 5 minutes calling `getMasteryNotifications(since:)`, with the last time seen kept in UserDefaults; a restart never re-shows a toast; failures back off through `Job`.
- **D3 Toast.** `MasteryToastController`, a copy of `MonologueToastController` (non-activating NSPanel, HUD material, 340 × 90, radius 18, `sharingType = .none`), with Open (deep link to `<web>/learner/osmosis?conceptId=<id>`), Nice and Not right; outcome sent with `recordNotificationFeedback`; no click within 8 s is `ignored`.
- **D4 Call hold and summaries.** No toast during a call; when the call ends, one toast or one summary; more than two at once is one summary.
- **D5 Tray.** A "🎓 Mastery" section after the learner-server lines with the learning baseline line; a coach baseline line under Speaking Coach; "waiting for learner-server" when offline; Settings › "Hold while I'm in a call".
- **D6** Positive only everywhere on the desktop.
- **D7 Tests.** Light/Medium tests for dedupe across restart, call hold, summary, feedback; `TrayMenuClickTests` and the tray UI test updated; all lanes green.
- **D8 Live.** Installed on Ben's Mac against the live server; one real notification shown end to end; its feedback row present on the server.

### Joint (J)

- **J1 Contract parity:** the desktop's pinned contract equals the server's `contract.json` for the new RPCs.
- **J2 Live end to end:** an assessment on dev (a reactive run, or one manual `startLearningConceptAssessment` on a concept Ben just practised) produces a toast on the Mac within 5 minutes; Open lands on the Map at that concept with the strip counting the gain; the feedback row exists.
- **J3 Adversarial review** against all ACs by a fresh-context reviewer in each repo, then a cross-check by the coordinator. Every finding fixed, or explicitly accepted by Ben.
- **J4** Status files in both repos show every AC accepted with evidence.

## Sync protocol

- learner-server owns the contract. Land S1 to S4 contract changes first and push; record the commit SHA in the status file under "Contract".
- learner-desktop reads the server status file each iteration (`git fetch` learner-studio/learner-server, or the GitHub API) and pins that SHA (D1). If the contract changes again, pin again.
- Status files: learner-server `docs/specs/mastery-notifications-status.md`, learner-desktop `docs/mastery-notifications-status.md`. One row per AC: state (todo / building / review / accepted / blocked), evidence, last updated.
- Tell the coordinator (send_message to `session_01BysNdGEv3M6N8KVsvGP3vC`, if you have that tool) on: contract pushed, a blocker, an AC accepted, done. The coordinator also reads the status file and transcript, so the status file is the channel of record.

## Loop rules

Start with the `loop` skill, self-paced (no interval). Keep it minimal, durable and self-healing:

- **Durable:** all state lives in the status file and git, never only in context. Every iteration starts by re-reading the brief and the status file, so a restart, compaction or crash resumes where it left off.
- **Self-healing:** a red check is the next task. Re-diagnose and fix; never skip or disable a test, never `--no-verify`. If the same failure survives three attempts, mark the AC blocked with the exact error and move to another AC.
- Product code stays minimal and self-healing too: prefer computing on read over new background state; any job or workflow step must be idempotent and recover after a restart (repo rule: a step running when its process died runs again).
- **Adversarial review is required:** before an AC goes to accepted, spawn a fresh subagent with only the AC text, the diff and the evidence, told to try to prove the AC is NOT met. Fix what it finds and repeat until it finds nothing. Record "reviewed: no findings" with the date in the status file.
- Repo rules win on conventions: CLAUDE.md push rules, the pre-push hook, secrets never printed.
- **Pacing:** while waiting on the other repo or a live check, wake every 20 to 30 minutes; otherwise continue immediately.
- Stop the loop only when every AC in this section and J1 to J4 are accepted, then send "DONE" with the final status file to the coordinator.

## Loop prompt

> Mastery notifications MVP (learner-server, S0–S8 and J1–J4): read docs/specs/mastery-notifications.md and docs/specs/mastery-notifications-status.md. Pick the next AC that is not accepted (contract-first; S0 early). Build it, test it, run a fresh-context adversarial review that tries to prove the AC is not met, fix what it finds, update the status file with evidence, commit and push through the hooks. Check learner-desktop's docs/mastery-notifications-status.md for sync. Stop only when all S ACs and J1–J4 are accepted.
