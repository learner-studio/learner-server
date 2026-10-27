# Checks: what runs when, and why it is this small

Three tiers. Each one runs the cheapest checks that can catch what it is there
to catch, and leaves the rest to the next tier. They get slower and harder to
skip as code gets closer to `main`.

| Tier | Where | When | Runs | Measured | Skippable? |
|---|---|---|---|---|---|
| pre-commit | your machine | `git commit` | tests co-located with the staged files | ~1–5s | `--no-verify` |
| pre-push | your machine | `git push` | `typecheck` + full test suite, in parallel | ~35s | `--no-verify` |
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
side by side, so the wait is about the slower one (33s measured), not the sum. It is exactly
what CI runs, so a green push should mean a green CI.

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

## Skipping

`--no-verify` skips a hook for one commit or push. Say why in the commit
message. CI cannot be skipped.
