# Contributing

1. Fork the repo and branch from `main`.
2. `bun install`, then `bun run hooks:install` to turn on the local checks.
3. Make the change with a test next to it (`foo.ts` → `foo.test.ts`).
4. Open a pull request against `main`.

CI runs `typecheck` and the test suite on every PR. If this is your first
contribution, a maintainer approves the CI run before it starts. A PR merges
once CI is green and the maintainer has approved it.

What runs where, and why: [docs/checks.md](docs/checks.md).
