# TODO

Durable follow-ups for Learner. Check an item off in the same commit that finishes it.

## Operator decisions

- [ ] Grant the `learner` role SELECT on `hindsight.public.biztools_learning_vectors`, then set
      `LEARNER_HINDSIGHT_DATABASE_URL` and `LEARNING_VECTOR_TURNS_READ_VIEW_ENABLED=true` in `/etc/learner/learner.env`.
      Concept assessment cannot start until then ("Native read-only integration view is not enabled").
- [ ] Create `/etc/learner/typesafe.env` (typed-decision arms) and `/etc/learner/langfuse.env` (trace export).
- [ ] Google OAuth client for human sign-in (`LEARNER_GOOGLE_CLIENT_ID` / `LEARNER_GOOGLE_CLIENT_SECRET`).
- [ ] Cutover (separate approval): systemd units, nginx host, delta data re-copy, repoint Claude/Codex hooks,
      carry the hook's `.off` markers to the new trace directory, stop the old learning worker.

## Engineering

- [ ] The opt-in exposure suites (`LEARNING_EXPOSURE_*`) TRUNCATE tables that other Learning tables reference by
      foreign key, so they need a dedicated scratch database rather than `learner_test`.
- [ ] Three ported tests assume `TMPDIR` is not `/var/tmp`. The test script pins `TMPDIR=/tmp`; make them independent of it.
- [ ] Port the Learning admin page (curriculum builder, conversation history, playground, graph, vector
      experiment, concept assessment panel) to the web app on shadcn components. The RPCs are already exposed.
- [ ] Port the remaining Learning experiments and scripts that are listed under "Left behind" in MIGRATION-LOG.md.
- [ ] Runtime parity: the framework runtime answers 403 for a keyless hindsight-bridge call, where standalone answers 401.
      Decide which answer is right and make both runtimes give it.
- [ ] Cutover must pick ONE runtime per environment. In-flight workflow runs do not move between runtimes, so drain or
      finish the runs before switching `LEARNER_RUNTIME`.
