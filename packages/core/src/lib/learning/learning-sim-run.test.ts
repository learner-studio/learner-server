import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frozenSimChanges, gitFreeEnv, simRunConfigs, simRunRefusal, type SimRunDesign } from './learning-sim-run.js'

const design = (o: Partial<SimRunDesign> = {}) => simRunConfigs({ runId: '00000000-0000-4000-8000-000000000001', arms: ['on', 'off'], lanes: ['fast'], perArm: () => 1, sessions: 2, turns: 2,
  models: { learner: 'm:low', agent: 'm:medium', scorer: 'm:medium' }, transport: 'codex', maxCalls: 6600, gradingReplicates: 1, sequential: false, looks: [10, 20, 30], commit: 'c', ...o })

// Review 10 S5 (X1): both sides of what a database may run. Every route to learner_sim goes through this: a refusal
// of a legitimate real run would stop the experiment, an accepted stub or test wiring would mix stub data into it.
describe('simRunRefusal: learner_sim runs only a capped real run; a test database only stub learners', () => {
  test('a real run on learner_sim is accepted at the pre-registered cap and looks', () => {
    expect(simRunRefusal('learner_sim', design())).toBeNull()
  })
  test('learner_sim refuses no cap, a cap above the pre-registered one, stub learners and test wiring', () => {
    expect(simRunRefusal('learner_sim', design({ maxCalls: null }))).toContain('call cap of at most 6600')
    expect(simRunRefusal('learner_sim', design({ maxCalls: 6601 }))).toContain('call cap of at most 6600')
    expect(simRunRefusal('learner_sim', design({ transport: 'stub' }))).toContain('the run has stub learners')
    expect(simRunRefusal('learner_sim', design(), { looks: [10, 20, 30] })).toBe('test wiring never runs on learner_sim')
    expect(simRunRefusal('learner_sim', design({ looks: [2, 4, 6] }))).toContain('are not 10,20,30')
  })
  test('a test database takes stub learners at the wiring\'s looks, never codex; no other database is a sim database', () => {
    const stub = design({ transport: 'stub', maxCalls: null, looks: [2, 4, 6] })
    expect(simRunRefusal('learner_sim_test_ab12cd34', stub, { looks: [2, 4, 6] })).toBeNull()
    expect(simRunRefusal('learner_sim_test', design({ maxCalls: null, looks: [2, 4, 6] }), { looks: [2, 4, 6] })).toContain('the run has codex learners')
    expect(simRunRefusal('learner', stub, { looks: [2, 4, 6] })).toBe('learner is not a sim database')
    // Pairs that reach the first look are the main batch: sequential only.
    expect(simRunRefusal('learner_sim_test', design({ transport: 'stub', maxCalls: null, looks: [1, 2, 3] }), { looks: [1, 2, 3] })).toContain('runs sequentially')
  })
})

// Review 2, N3: the run's code is checked against the commit it recorded; any change to a frozen path (every package,
// the root manifests, the spec) is reported, any other change is not.
test('frozen sim code and spec: changed, new and spec files are reported against the recorded commit; others are not', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'sim-frozen-'))
  try {
    const sh = (cmd: string) => { const r = Bun.spawnSync(['bash', '-c', cmd], { cwd: repo, env: gitFreeEnv() }); if (r.exitCode) throw new Error(r.stderr.toString()) }
    sh(`git init -q && git config user.email t@t && git config user.name t && mkdir -p packages/core/src/lib/learning docs/specs
      echo a > packages/core/src/lib/learning/learning-sim-analysis.ts && echo b > packages/core/src/lib/learning/other.ts && echo c > docs/specs/simulated-learner-experiment.md
      git add -A && git commit -qm base`)
    const commit = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD'], { env: gitFreeEnv() }).stdout.toString().trim()
    expect(frozenSimChanges(commit, repo)).toEqual([])
    sh('echo changed > README.md')
    expect(frozenSimChanges(commit, repo)).toEqual([])
    sh('echo changed > packages/core/src/lib/learning/other.ts')
    expect(frozenSimChanges(commit, repo)).toEqual(['packages/core/src/lib/learning/other.ts'])
    sh('echo scored-differently >> packages/core/src/lib/learning/learning-sim-analysis.ts && echo x > packages/core/src/lib/learning/learning-sim-new.ts && echo d >> docs/specs/simulated-learner-experiment.md')
    expect(frozenSimChanges(commit, repo).sort()).toEqual(['docs/specs/simulated-learner-experiment.md', 'packages/core/src/lib/learning/learning-sim-analysis.ts', 'packages/core/src/lib/learning/learning-sim-new.ts', 'packages/core/src/lib/learning/other.ts'])
    sh('git add -A && git commit -qm later')
    expect(frozenSimChanges(commit, repo)).toHaveLength(4) // committed later still differs from the recorded commit
    expect(frozenSimChanges('0'.repeat(40), repo)).toEqual([`commit ${'0'.repeat(40)} not found`])
    // Under a git hook (GIT_DIR and GIT_INDEX_FILE exported, here at a second throwaway repository) the check still
    // reads `repo`, not the hook's repository.
    sh('git init -q --bare hook.git')
    const probe = Bun.spawnSync(['bun', '-e', `const { frozenSimChanges } = await import(${JSON.stringify(join(import.meta.dir, 'learning-sim-run.ts'))}); console.log(JSON.stringify(frozenSimChanges(${JSON.stringify(commit)}, ${JSON.stringify(repo)})))`],
      { env: { ...gitFreeEnv(), GIT_DIR: join(repo, 'hook.git'), GIT_INDEX_FILE: join(repo, 'hook.index') } })
    expect(JSON.parse(probe.stdout.toString())).toHaveLength(4) // the same four; the hook's repository would say 'not found'
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
