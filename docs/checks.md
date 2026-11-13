# Checks: what runs when, and why it is this small

Three tiers. Each one runs the cheapest checks that can catch what it is there
to catch, and leaves the rest to the next tier. They get slower and harder to
skip as code gets closer to `main`.

| Tier | Where | When | Runs | Measured | Skippable? |
|---|---|---|---|---|---|
| pre-commit | your machine | `git commit` | tests co-located with the staged files | ~1–5s | `--no-verify` |
| pre-push | your machine | `git push` | framework codegen (`runtime.ts prepare`, skipped when fresh), `pikku update` (red when a newer `@pikku/*` is published; warns only when the registry is unreachable or takes over 15 s; `LEARNER_SKIP_PIKKU_UPDATE=1` skips this check alone), then `typecheck` + full test suite, in parallel; the suite on a fresh database in CI's Postgres image (`scripts/test-clean-db.ts`) | ~55s | `--no-verify` |
| CI | GitHub Actions | every push to `main`, every PR | the same two, on a clean checkout with a throwaway Postgres | ~2 min | no: a PR cannot merge red |

Timings measured 2026-10-27 on the dev box: typecheck 15s, full suite 44s
(130 files, 798 pass, 84 skip).

## Setup (once per clone)

```bash
bun run hooks:install        # = git config core.hooksPath .githooks
```

Git does not carry hook config inside the repo, so a fresh clone has no hooks
until you run this. CI does not depend on it.

## Why each tier holds what it holds

**pre-commit: co-located tests only.** You commit far more often than you
push, so every second here is paid many times. It runs `foo.test.ts` when you
stage `foo.ts` (or the test itself), nothing else; a docs-only commit runs
nothing. It does **not** typecheck (15s) or follow imports: a change to `foo.ts`
that breaks `bar.test.ts` is caught at push. A hook that is slow gets skipped
by habit, and a skipped hook catches nothing.

**pre-push: typecheck + the full suite.** This is where everything that the
commit tier skipped gets checked, before anyone else sees the code. The two run
side by side, so the wait is about the slower one (33s measured), not the sum. It is
exactly what CI runs, on the same kind of database: `scripts/test-clean-db.ts`
creates a fresh database in a long-lived `postgres:17` container
(`learner-ci-pg`, 127.0.0.1:55440, data on tmpfs, ~600 MB), migrates it, runs
the suite and drops it. Measured 2026-11-11: ~55s for the suite including the
migration. Without Docker the hook falls back to `learner_test` and says so in
its output.

**CI: the same checks, but on the commit itself.** Both hooks read your
*working tree*: uncommitted edits, yours or another agent's in a shared
checkout, a stale generated file, a local env var. Any of those can make a hook
pass on code that does not work from a fresh clone. CI checks out the exact
commit on a machine that has never seen this box, installs with
`--frozen-lockfile`, migrates an empty Postgres, and runs the suite. Only CI
can block a merge.

## Deliberately left out

| Check | Why not in a tier | When to run it |
|---|---|---|
| `bun run gate` | boots the API + worker, needs `/etc/learner/*.env` and a free :3010 | by hand, before a release |
| `bun run build:web` | the UI build; typecheck already covers its types | when you touch `apps/web` build config |
| `bun run test:python`, `integrations/*` | separate toolchains, rarely changed | when you touch them |
| lint / format | there is no linter in this repo; adding one is its own decision | — |

If one of these starts catching real breakage, add it to the cheapest tier
that can hold it, and update the table above with its measured cost.

## Merge rule on `main` (GitHub ruleset "main")

- Changes reach `main` through a pull request.
- The PR needs the `typecheck` and `test` CI jobs green **and** an approving
  review from the code owner (`.github/CODEOWNERS`).
- No force-pushes to `main`, and it cannot be deleted.
- Repository admins can bypass the rule, so the owner's direct pushes from the
  dev box keep working. Those still run the pre-push hook and CI.

Anyone can fork the public repo and open a PR. Only people with write access
can merge, and the ruleset above also applies to them.

**Fork PRs and CI.** A PR can edit `.github/workflows/ci.yml` itself, so a
first-time contributor's workflow runs wait for a maintainer to press
"Approve and run" (repo setting: approval required for all outside
contributors). The workflow uses `pull_request`, never `pull_request_target`,
holds no secrets, and has a read-only token.

## Agents pushing as the owner

Agents on the dev box push to `main` directly, with no PR and no human
approval. They authenticate as the owner's GitHub account (an admin, via the
stored git credential), and the ruleset lets admins bypass. What they must
clear is the gate: the pre-push hook runs on every push, and a red hook stops
the push. CI then re-runs the same checks on the pushed commit.

Rules for agents:
- Never `--no-verify`. The bypass exists so humans can skip a broken hook on
  purpose, not so a failing push can get through.
- A red pre-push means fix it and push again; do not ask the owner.
- In a shared checkout the hook reads other agents' uncommitted edits too. If
  it fails on a file you did not touch, commit from your own worktree
  (`git worktree add`) rather than skipping the hook.
- If CI goes red on `main` after a push, the next push fixes it.

## What the local gate missed, and why the database matters (2026-11-11)

7 of 12 CI runs on `main` failed while the same commits passed pre-push. Four
causes, all fixed; the first two only show on a database like CI's:

1. **Collation.** CI's `postgres:17` is `en_US.utf8`; the dev box's
   `learner_test` is `C.UTF-8`. `ORDER BY concept_id` puts `kt-…-c10-0` before
   `kt-…-c1-1` in en_US (it ignores `-`) and after it in C. The prior-blind
   statistics bootstrap resamples concepts by position, so the order moved the
   intervals in the third digit while every estimate stayed equal
   (`mastery-known-truth-seed.integration.test.ts`, about half of all runs on
   CI, never here). Fix: `groupByConcept` returns concepts in code-point order
   of their id, so no statistic depends on the order rows arrive in.
2. **A test that disabled a trigger for everyone.**
   `learning-assessment-run-digest.integration.test.ts` cleaned up with
   `ALTER TABLE … DISABLE TRIGGER`. That waits for every open transaction on
   the table and queues every later insert behind it, and it is table-wide:
   when its hook timed out, the immutability trigger stayed off for the rest of
   the run and an unrelated file failed (`learning-curriculum-generation-store`,
   "expected DELETE to be refused"). Fix: it deletes through a purge
   (`learner.curriculum_purge`), row locks only. **Tests never run DDL on
   shared tables**; use a temp table, a transaction, or the app's own path.
3. **The 5 s per-test default.** On a slow runner the database tests ran 3–5 s
   and passed at up to 4.98 s; the ones that crossed 5 s were killed, and their
   `afterEach` closed the client under the running query, so the failure read
   `error: Connection terminated`. `scripts/run-tests.ts` now passes
   `--timeout 30000` (`TEST_TIMEOUT_MS`): still a hang detector, no longer at
   the normal duration.

4. **A livelocked SQLite backup** (`lossless-archive-sqlite-concurrency`, runs
   43031827372 and 43071341657, 60 s timeout). The archiver copied a live
   SQLite database 256 pages at a time; a commit from another connection
   between steps restarts the copy, so it finished only when a whole pass fit
   between two of the test writer's commits (every ~5 ms). Instrumented: one
   restart per copy at normal speed, 29 with 2 ms added per step. Fix in
   `lossless-archive-files.ts`: one step (`pages=-1`), one read transaction,
   no restart possible; in WAL mode it does not block the writer. This was a
   production bug too: archiving a busy provider database could stall the
   same way.

5. **The gate itself under concurrent pushes** (2026-11-11 evening). One gate
   run peaks at ~75 connections; the gate container allowed 100, so two agents
   pushing at once failed with `sorry, too many clients already` (647 refusals
   in 40 minutes). And the sim and drift tests, which create a database of
   their own, used one per CHECKOUT (or the shared `learner_sim_test`), so
   concurrent runs shared it and every run leaked one (42 databases, 914 MB of
   the 2 GB tmpfs). Fixes: `scripts/test-clean-db.ts` takes one of
   `floor((max_connections - 20) / 90)` slots under `flock` and a push past
   that waits ("all N slot(s) busy; waiting"); a new container gets
   `max_connections=300` (3 slots). Every test that needs its own database
   calls `ownTestDatabaseUrl(kind)` (`packages/core/src/db/own-test-database.ts`):
   one per RUN where the role may create it, tagged with the run, dropped with
   it; the admin-created one per checkout on the dev box otherwise.

Rule for new tests: a result that depends on row order needs an `ORDER BY` that
does not depend on collation (or code that sorts itself); a database test must
leave nothing behind that another file can see. A test that needs a database of its own
calls `ownTestDatabaseUrl`, never a fixed name and never a copy of that helper.

## CI on every push to `main`

Kept. Agents push to `main` directly, so the push run is the only check of the
exact commit on a clean machine; dropping it would leave the PR rule (which
covers outside contributors) as the only CI.

What changed (2026-11-11) is cancellation. GitHub emails "Run cancelled" as
well as "Run failed", and with `cancel-in-progress` on `ci-<ref>` every push to
`main` that landed within ~2 minutes of the next one produced a cancellation
email and a commit with no verdict. Now a PR keeps cancel-on-supersede, and a
push to `main` runs in its own group (`ci-<sha>`) to the end: one email only
when a commit is actually red, and that email names the commit that broke it.
The cost is runner minutes, which are free for a public repo.

## Skipping

`--no-verify` skips a hook for one commit or push. Say why in the commit
message. CI cannot be skipped.
