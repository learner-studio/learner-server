# Mastery statistics: wiring verification (2026-11-11)

Spec: `docs/specs/mastery-change-statistics.md`. Commands run in the lane worktree to verify the new
RPCs and workflow steps are registered by Pikku (this file may name the framework; the spec may not).

```bash
bun scripts/gen-registry.ts
flock /run/learner/prepare.lock bun scripts/runtime.ts prepare        # "framework codegen clean"
cd packages/runtime-pikku
bun ../../node_modules/@pikku/cli/dist/bin/pikku.js all               # what prepare runs; fails on any diagnostic
# RPCs
jq -r 'to_entries[] | select(.key|test("getMasteryChanges|getHoldoutEffect")) | "\(.key) expose=\(.value.expose)"' .pikku/function/pikku-functions-meta.gen.json
jq -r 'keys[]' .pikku/rpc/pikku-rpc-wirings-meta.internal.gen.json | rg 'getMasteryChanges|getHoldoutEffect'
# Workflow steps, in order
for w in learningConceptAssessmentWorkflow learningReactiveConceptWorkflow; do
  jq -r '.. | objects | select(has("rpcName")) | .rpcName' .pikku/workflow/meta/$w.gen.json
done
```

Result at the time of writing: both RPCs `expose=true` and in the RPC wiring map;
`learningConceptAssessmentWorkflow`: plan → execute → replicate → combine → publish;
`learningReactiveConceptWorkflow`: execute (per batch) → plan → replicate → combine → finish → publish.
The DSL rejects iterating `.entries()` (PKU641), which is why the reactive replicates run after the
batch loop, on the pass's last part.
