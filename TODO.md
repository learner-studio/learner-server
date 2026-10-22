# TODO

Durable follow-ups for Learner. Check an item off in the same commit that finishes it.

## Operator decisions

- [x] Grant the `learner` role SELECT on `hindsight.public.biztools_learning_vectors` (operator, 2026-10-22). Both
      `LEARNER_HINDSIGHT_DATABASE_URL` and `LEARNING_VECTOR_TURNS_READ_VIEW_ENABLED=true` are now set in
      `/etc/learner/learner.env`.
- [x] Create `/etc/learner/typesafe.env` and `/etc/learner/langfuse.env` (operator, 2026-10-22).
- [ ] Concepts with a lot of evidence refuse to start an assessment: the input exceeds the 400,000-byte budget
      (433k–717k on 2026-10-22, e.g. `architecture-event-systems--workflow-orchestration`). The refusal is by
      design, because evidence is never truncated, but it means those concepts can't be assessed live until
      selection narrows or the budget changes.
- [ ] Google OAuth client for human sign-in (`LEARNER_GOOGLE_CLIENT_ID` / `LEARNER_GOOGLE_CLIENT_SECRET`).
- [ ] Cutover (separate approval): systemd units, nginx host, delta data re-copy, repoint Claude/Codex hooks,
      carry the hook's `.off` markers to the new trace directory, stop the old learning worker.

## Engineering

- [ ] The opt-in exposure suites (`LEARNING_EXPOSURE_*`) TRUNCATE tables that other Learning tables reference by
      foreign key, so they need a dedicated scratch database rather than `learner_test`.
- [ ] Three ported tests assume `TMPDIR` is not `/var/tmp`. The test script pins `TMPDIR=/tmp`; make them independent of it.
- [ ] First `scripts/learning/isolated-suites.ts --run` needs operator approval, because it creates disposable
      `learner_*_test_<uuid>` databases. Once it passes, it replaces the exposure-suite item above.
- [ ] The Hindsight launchers still default to the previous host's install, `/opt/biztools-hindsight` and its env file.
      The state root `/var/lib/learner-hindsight/experiments` does not exist yet. The agy bridge headers keep their old
      `x-biztools-*` names, so renaming them means changing both sides.
- [ ] `bun run test` does not discover the Python runner tests. Run them under the Hindsight venv:
      `PYTHONPATH=/opt/biztools-hindsight/src /opt/biztools-hindsight/venv/bin/python scripts/hindsight/<file>.test.py`.
- [ ] Historical step rows of terminal workflow runs were not copied, so exports of old runs have no steps. The
      source has 452 playground steps. If they are wanted, re-copy them at cutover.
- [ ] Runtime parity: the framework runtime answers 403 for a keyless hindsight-bridge call, where standalone answers 401.
      Decide which answer is right and make both runtimes give it.
- [ ] Cutover must pick ONE runtime per environment. In-flight workflow runs do not move between runtimes, so drain or
      finish the runs before switching `LEARNER_RUNTIME`.
