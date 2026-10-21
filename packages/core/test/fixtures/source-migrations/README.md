Historical migrations from the previous host (see MIGRATION-SOURCE.md), kept
only as fixtures: some integration tests build an isolated schema from the
exact migration that introduced a table, function or trigger. The schema of
record is `packages/server/src/db/migrations`. The only edit is the workflow table
rename (`workflow_runs` -> `learner_workflow_runs`, `workflow_step` ->
`learner_workflow_steps`).
