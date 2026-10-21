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
