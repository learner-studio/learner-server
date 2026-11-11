# Reactive grading workflows under Pikku

Companion to `docs/operations/reactive-grading-runbook.md` (which may not name the
framework: `tests/separation.test.ts`). Run the CLI from this package, never via bunx.

```bash
cd packages/runtime-pikku
P="bun ../../node_modules/@pikku/cli/dist/bin/pikku.js"
$P meta workflows list                                       # every workflow id
$P meta workflows get learningReactiveRoutingWorkflow        # step graph JSON
$P meta workflows get learningReactiveConceptWorkflow
$P meta workflows get learningReactiveStallCheckWorkflow
$P meta workflows get learningReactiveRecoveryWorkflow
```

What they showed on 2026-11-11 (mode `distributed`, every step an `rpc` step):

| Workflow | Steps (name → RPC) |
|---|---|
| learningReactiveRoutingWorkflow | Admit already-routed concepts → dispatchLearningReactiveConceptsStep; Route pending indexed messages → routeLearningReactiveArrivalsStep; Admit affected concepts → dispatchLearningReactiveConceptsStep |
| learningReactiveConceptWorkflow | Coalesce related arrivals (sleep); Claim only the current dirty generation; Initialize immutable live vector run; Reuse top-50 original turn selection; (fan-out of assessment parts); Record full receipt coverage; Publish only validated final node estimate; Acknowledge only the assessed generation; Immediately refill rolling concept slots |
| learningReactiveStallCheckWorkflow | Measure reactive grading progress → measureLearningReactiveHealthStep (retries 2); Fail when grading has stalled → assertLearningReactiveMovingStep (retries 0) |
| learningReactiveRecoveryWorkflow | Reconcile indexed chunks without vectors → reconcileLearningIndexVectorsStep; Plan release of blocked concepts → planLearningReactiveRecoveryStep; branch on `apply`: Release concepts blocked before any paid call, Route pending indexed messages, Admit at the configured concurrency |

The Console workflow RPCs are not available: this package's `pikku.config.json`
leaves the console scaffold off. Run state is read from the workflow tables the
service writes (`learner_workflow_runs`, `learner_workflow_steps`); see the
neutral runbook for the queries.

Wiring is generated: the workflows live in `packages/server/src/wirings/*.workflow.ts`,
`scripts/gen-wiring.ts` copies them to `src/generated/workflows/*.gen.ts`. After adding
one: `bun scripts/gen-registry.ts`, then `bun run generate` here (fails on any CLI
diagnostic; check for "Skipping"), or on the dev box
`flock /run/learner/prepare.lock bun scripts/runtime.ts prepare`.

Tests: `tests/reactive-stall-check.test.ts` runs the stall check as a queued run on
pg-boss (schema `learner_pikku_boss_test`); its standalone twin is
`packages/runtime-standalone/src/workflow/reactive-stall-check.test.ts`.
