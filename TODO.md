# TODO

Durable follow-ups for Learner. Check an item off in the same commit that finishes it.

## Operator decisions

- [ ] `integrations/openclaw-learning-archive` (moved from biztools `ops/openclaw/learning-archive`, 2026-10-22) has one
      red test, failing identically before the move: `history.test.ts` "pages read-only rows, preserves exact
      parent/native identity..." gives the captured and the refused user observation the same `observationId`. The
      plugin runs inside OpenClaw, which is not on this box; fix before deploying it. Outside the default test run.

- [x] Grant the `learner` role SELECT on `hindsight.public.biztools_learning_vectors` (operator, 2026-10-22; renamed `learner_learning_vectors`, learner-only, 2026-10-22). Both
      `LEARNER_HINDSIGHT_DATABASE_URL` and `LEARNING_VECTOR_TURNS_READ_VIEW_ENABLED=true` are now set in
      `/etc/learner/learner.env`.
- [x] Create `/etc/learner/typesafe.env` and `/etc/learner/langfuse.env` (operator, 2026-10-22).
- [ ] Single-concept assessment path refuses >400k concepts; make it reuse the incremental slice packing (same
      behaviour as biztools today). Manual path only (`startLearningConceptAssessment` ->
      `learningConceptAssessmentWorkflow`, one call by design). The reactive cold path already packs them:
      `scripts/learning/prepare-probe.ts` on 2026-10-22 prepared clarification-threshold as 4 parts of
      225-329 kB, workflow-orchestration (433k on the manual path) as 4 and workflow-durable-steps--checkpoint
      (717k) as 5, every part under 400,000 bytes.
- [ ] Google OAuth client for human sign-in (`LEARNER_GOOGLE_CLIENT_ID` / `LEARNER_GOOGLE_CLIENT_SECRET`).
- [ ] Cutover (separate approval): systemd units, nginx host, delta data re-copy, repoint Claude/Codex hooks,
      carry the hook's `.off` markers to the new trace directory, stop the old learning worker.

## Engineering

- [ ] `copy-learning-data.ts --reset` spends most of its time on `learning_vector_turn_experiments` (55 GB on disk, 7,180 rows of ~9.7 MB pass snapshots;
      ~130 GB streamed as text, ~4 GB/min on 2026-10-22). Live Learning never reads them: copy the snapshots separately (or
      on demand for exports) so a re-copy is ~15 min instead of ~55.
- [x] Three ported tests assumed `TMPDIR` is not `/var/tmp`; all were filesystem assumptions (inode reuse, readdir
      order, `os.tmpdir()` standing in for the /tmp tmpfs), now fixed. `bun run test` no longer pins `TMPDIR`.
- [x] The opt-in exposure and consolidation-trigger suites run in disposable databases:
      `scripts/learning/isolated-suites.ts --run` (root). First run 2026-10-22: exposure 33+12 pass,
      consolidation-trigger 7 pass, both databases dropped.
- [x] Hindsight paths are Learner-owned: install root `/opt/learner-hindsight`, model cache
      `/var/lib/learner-hindsight/cache`, state root `/var/lib/learner-hindsight/experiments` (created). On the dev box the
      first two are symlinks to the previous host's build, since a venv is not relocatable. Overrides:
      `HINDSIGHT_INSTALL_ROOT`, `LEARNER_HINDSIGHT_CACHE`, `HINDSIGHT_ENV_FILE`. The `x-biztools-*` bridge headers keep
      their names on purpose (launcher and bridge must rename together; noted in `agy-runtime.sh`).
- [x] `/etc/learner/hindsight.env` copied from the old host's env file (operator, 2026-10-22, mode 600); the launchers
      read it first.
- [x] The Python runner tests import Hindsight, so `bun test` cannot run them: `bun run test:python` runs every
      `scripts/hindsight/*.test.py` under the Hindsight venv (`HINDSIGHT_INSTALL_ROOT` overrides the root).
- [x] Historical step rows of terminal workflow runs were not copied, so exports of old runs have no steps. The
      source has 452 playground steps. Folded into `copy-learning-data.ts` (`copiedSteps`: non-terminal runs plus
      every `learningPlaygroundWorkflow` step); `verify-copy.ts` checks the step count. Lands with the phase-2 copy.
- [x] Runtime parity: a keyless hindsight-bridge call is 401 in both runtimes (no credential = unauthenticated); a
      signed-in caller without a key stays 403. The gate checks it under both runtimes.
- [ ] Cutover must pick ONE runtime per environment. In-flight workflow runs do not move between runtimes, so drain or
      finish the runs before switching `LEARNER_RUNTIME`.
