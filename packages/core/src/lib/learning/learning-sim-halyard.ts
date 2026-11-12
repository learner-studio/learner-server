import type { LearningGraph } from '../../functions/learning/learning-seed.js'
import type { CurriculumRows } from './curriculum-writer.js'
import { liveCatalogOf } from './learning-live-catalog.js'

/**
 * Halyard: an invented event-pipeline runtime, the curriculum of the simulated-learner experiment
 * (docs/specs/simulated-learner-experiment.md). Every mechanism, name and number here is fictional, so
 * no model can know it in advance: a simulated learner can only learn it from what the agent taught in
 * earlier sessions and kept in its own notebook.
 *
 * The id prefix `halyard-core` was chosen before any run, among 20 candidate prefixes, as the first
 * neutral one whose holdout (the product's md5 bucket, learning-concept-holdout.ts) holds three concepts
 * on three different branches with the same mean prerequisite depth as the taught set (2.0 and 2.0).
 */
const P = 'halyard-core--'
const HALYARD_CURRICULUM_ID = 'sim-halyard'
const PROVENANCE = { kind: 'human-curated' as const, source: 'simulated-learner experiment (fictional)', version: 'halyard-1' }

type ConceptSeed = { slug: string; title: string; summary: string; explanation: string; example: string; objectives: string[]; terms: string[] }

const CONCEPTS: ConceptSeed[] = [
  { slug: 'tessel', title: 'Tessel',
    summary: 'The unit of data in Halyard: an immutable bundle of one keel key, a payload of named fields and a ballast fingerprint.',
    explanation: 'Producers "loft" tessels into a reach (a named stream); moorings read them. A tessel is never edited in place: any change to an origin\'s data is a new tessel (a rebraid). Because tessels are immutable, two readers that read the same keel key always see the same payload.',
    example: 'A shipment update {origin: "SHP-1042", epoch: 3, fields: {weight_kg: 812, depot: "RTM"}} is one tessel in the reach shipment-events.',
    objectives: ['Explain why a tessel is never modified in place and what happens instead.', 'Name the three parts of a tessel and what each is for.'],
    terms: ['tessel', 'loft'] },
  { slug: 'keel-key', title: 'Keel key',
    summary: 'The identity of a tessel: the pair (origin, epoch). Ordering in a reach is by epoch, then origin, never by arrival time.',
    explanation: 'origin is a stable business id chosen by the producer (for example a shipment id); epoch is an integer that starts at 1 for each origin. The current version of an origin is the tessel with its highest epoch. Within a reach, tessels are ordered by epoch first and, for equal epochs, by origin in lexicographic order; arrival time plays no part, so a late-arriving tessel can sort before earlier arrivals. Two tessels with the same origin and epoch are twins.',
    example: 'SHP-7 epoch 2 sorts before SHP-1 epoch 3 even if it arrived later; SHP-1 epoch 2 sorts before SHP-7 epoch 2.',
    objectives: ['Predict the order of tessels in a reach from their keel keys.', 'Explain what "current version" of an origin means.'],
    terms: ['keel key', 'keel-key', 'epoch', 'origin'] },
  { slug: 'twin-rule', title: 'Twin rule',
    summary: 'A tessel whose keel key already exists in the reach is discarded silently, whatever its payload, unless it carries the overbear flag.',
    explanation: 'The first tessel to arrive with a given (origin, epoch) wins; later twins are dropped without an error and counted in the twins_dropped metric. So re-lofting a corrected payload under the same epoch changes nothing, and retrying a loft after a timeout is always safe: the retry is either the first arrival or a dropped twin, never a duplicate.',
    example: 'A producer lofts SHP-1042 epoch 3 with weight 812, then again with weight 790: consumers keep reading 812 and twins_dropped increases by 1.',
    objectives: ['Predict what happens when the same keel key is lofted twice with different payloads.', 'Explain why loft retries are safe under the twin rule.'],
    terms: ['twin', 'twins_dropped'] },
  { slug: 'overbear', title: 'Overbear',
    summary: 'A flag that makes a tessel replace its twin instead of being dropped; reserved for producers with the helm role and audited.',
    explanation: 'An overbear tessel replaces the existing tessel with the same keel key for future reads only: moorings that already read the original are not re-delivered the replacement, so they keep acting on the old payload. Every overbear is written to the audit reach. Overbear tessels are never becalmed, and during a squall they are the only lofts accepted. It is an operator tool for emergencies, not a way to publish corrections (that is a rebraid).',
    example: 'An operator overbears SHP-9 epoch 4 to fix a corrupted depot code; the billing mooring, which had already read epoch 4, still holds the corrupted value.',
    objectives: ['Explain what overbear changes and what it does not change for moorings that already read the original.', 'Decide when overbear is appropriate versus a rebraid.'],
    terms: ['overbear', 'helm'] },
  { slug: 'rebraid', title: 'Rebraid',
    summary: 'The only way to change an origin\'s data: loft a new tessel with the same origin and exactly epoch + 1; the old epoch is retired.',
    explanation: 'A rebraid must use exactly the next epoch: skipping (epoch + 2 or more) is rejected with GAP, and reusing the same epoch is a twin. The previous epoch becomes retired, not deleted: it stays readable during the slack window. Every rebraid passes the ballast check against the previous epoch.',
    example: 'To correct SHP-1042 from epoch 3, loft SHP-1042 epoch 4; lofting epoch 5 directly fails with GAP.',
    objectives: ['Carry out a correction as a rebraid with the right epoch.', 'Explain what happens to the previous epoch after a rebraid.'],
    terms: ['rebraid', 'GAP', 'retired'] },
  { slug: 'slack-window', title: 'Slack window',
    summary: 'A retired tessel stays readable for exactly 3 beats after the beat in which it was retired; afterwards a pinned read fails with LAPSED.',
    explanation: 'A reader can pin an epoch (read origin X at epoch N). During the slack window the pinned read succeeds; after it, the read fails with LAPSED. The window is counted in beats, not wall-clock time, so when beats stall the window stretches: retired tessels stay readable longer and storage grows. A job that pins epochs must finish within 3 beats of the rebraid, or read the current epoch instead.',
    example: 'SHP-1042 epoch 3 was retired at beat 120; a pinned read of epoch 3 succeeds through beat 123 and fails with LAPSED at beat 124.',
    objectives: ['Predict whether a pinned read succeeds given the retirement beat and the current beat.', 'Explain why stalled beats make storage grow.'],
    terms: ['slack window', 'slack', 'LAPSED', 'pinned', 'pin'] },
  { slug: 'beat', title: 'Beat',
    summary: 'The logical clock of a reach: a beat advances only when every mooring has acknowledged every tessel lofted before that beat started.',
    explanation: 'Beats are not timer ticks. Healthy reaches advance about every 10 seconds, but a single mooring that stops acknowledging (slow, crashed, or offline but still registered) stops the beat for the whole reach. Everything measured in beats (the slack window, refit windows, squall detection) therefore depends on the slowest mooring. Logs show the current beat as beat=N.',
    example: 'shipment-events has three moorings; the billing mooring crashes and stops acking, so beat stays at 340 while the other two moorings keep reading.',
    objectives: ['Explain what makes a beat advance and what stalls it.', 'Trace how one slow mooring affects other beat-based behaviour.'],
    terms: ['beat'] },
  { slug: 'mooring', title: 'Mooring',
    summary: 'A registered, durable consumer of a reach with a name, a draft limit and an acknowledgement position.',
    explanation: 'A mooring exists until it is explicitly unmoored (deregistered). An offline mooring is still a mooring: its acknowledgement position does not move, so it still blocks beats. Adding a mooring therefore makes every beat on the reach depend on it; retiring a consumer means unmooring it, not just stopping its process.',
    example: 'A team turns off its old analytics consumer but never runs halyard unmoor analytics-v1; beats on the reach stop advancing.',
    objectives: ['Explain why a stopped consumer can still affect a reach.', 'Decide what to do when retiring or adding a consumer.'],
    terms: ['mooring', 'unmoor', 'moorings'] },
  { slug: 'draft-limit', title: 'Draft limit',
    summary: 'The maximum number of unacknowledged tessels a mooring may hold (default 64); reaching it becalms producers.',
    explanation: 'Each mooring has a draft limit. When its unacknowledged count reaches the limit, producers lofting to that reach are becalmed. Raising the limit trades memory for fewer becalmings; it does not make the consumer process tessels faster, so a consumer that is too slow will reach any limit eventually.',
    example: 'The billing mooring has draft 64 and acks 20 tessels/s while producers loft 30/s: it reaches 64 within seconds and producers are becalmed.',
    objectives: ['Predict when a mooring reaches its draft limit from loft and ack rates.', 'Explain what raising the draft limit does and does not fix.'],
    terms: ['draft limit', 'draft'] },
  { slug: 'becalming', title: 'Becalming',
    summary: 'Halyard\'s backpressure: loft calls block (they are not rejected and nothing is dropped) until the mooring acks back below 75% of its draft limit.',
    explanation: 'While becalmed, producers see loft latency rise and the becalmed_ms metric climbs. Release uses hysteresis: lofts resume only when the mooring\'s unacknowledged count falls below 75% of its draft limit, not merely below the limit. A producer whose loft timeout is shorter than the becalming gets LOFT_TIMEOUT; retrying is safe because of the twin rule. A producer becalmed continuously for more than 10 minutes puts the reach into squall.',
    example: 'With draft 64, lofts block at 64 unacknowledged tessels and resume when the count drops below 48.',
    objectives: ['Explain what producers experience while becalmed and when lofts resume.', 'Decide how a producer should handle LOFT_TIMEOUT during becalming.'],
    terms: ['becalm', 'becalmed', 'becalming', 'becalmed_ms', 'LOFT_TIMEOUT'] },
  { slug: 'ballast-check', title: 'Ballast check',
    summary: 'Each tessel carries a ballast fingerprint, a hash of its sorted field NAMES; a rebraid whose field set differs from the previous epoch is rejected with LISTING unless a refit is active.',
    explanation: 'The ballast depends only on which fields exist, never on their values, so changing values never trips the check while adding, removing or renaming a field always does. The check compares a rebraid with the previous epoch of the same origin; a brand-new origin (epoch 1) has nothing to compare with and is accepted.',
    example: 'Rebraiding SHP-1042 with an extra field reweigh_reason fails with LISTING; rebraiding it with a new weight value passes.',
    objectives: ['Predict whether a rebraid passes the ballast check from its field set.', 'Explain why value changes never trip the check.'],
    terms: ['ballast', 'LISTING'] },
  { slug: 'refit', title: 'Refit',
    summary: 'A declared schema change for a reach: added and removed fields plus a refit window of at least 5 beats during which old and new ballasts are both accepted.',
    explanation: 'During the refit window rebraids with either the old or the new ballast pass. Each mooring declares which ballast it understands; after the window only the new ballast is accepted. Removing a field requires every mooring to have declared the new ballast before the refit starts, otherwise the refit is refused with MOORING_UNREADY. Adding a field has no such precondition.',
    example: 'halyard refit shipment-events --add customs_code --window 8 lets producers send either shape for 8 beats.',
    objectives: ['Plan a schema change with a refit, including its window.', 'Explain why removing a field needs every mooring ready first while adding one does not.'],
    terms: ['refit', 'MOORING_UNREADY'] },
  { slug: 'squall', title: 'Squall',
    summary: 'A reach\'s failure mode, entered when beats stall for more than 30 beat intervals or a producer is becalmed for more than 10 minutes.',
    explanation: 'In squall all non-overbear lofts are rejected immediately with SQUALL (not blocked), and retired tessels are not expired. Squall never ends by itself: after fixing the cause (for example unmooring a dead mooring), an operator runs halyard clear-squall. Overbearing everything to get data through does not fix the stall and corrupts what moorings have already read.',
    example: 'A dead mooring stalls beats for 6 minutes; the reach enters squall and every producer gets SQUALL until the mooring is unmoored and clear-squall is run.',
    objectives: ['Recognise the two conditions that cause a squall and what producers see in it.', 'Plan the recovery from a squall, including what does not work.'],
    terms: ['squall', 'clear-squall', 'SQUALL'] },
]

const EDGES: Array<[string, string]> = [
  ['tessel', 'keel-key'], ['tessel', 'rebraid'], ['keel-key', 'twin-rule'], ['twin-rule', 'overbear'], ['keel-key', 'rebraid'],
  ['rebraid', 'slack-window'], ['beat', 'slack-window'], ['mooring', 'beat'], ['mooring', 'draft-limit'], ['draft-limit', 'becalming'],
  ['becalming', 'squall'], ['beat', 'squall'], ['rebraid', 'ballast-check'], ['ballast-check', 'refit'], ['overbear', 'squall'],
]

export const halyardId = (slug: string) => `${P}${slug}`

export const HALYARD: LearningGraph = {
  curriculum: {
    id: HALYARD_CURRICULUM_ID, title: 'Halyard (simulated-learner experiment)', status: 'seed', domain: 'simulated-learner',
    description: 'A fictional event-pipeline runtime used only by the simulated-learner experiment.', provenance: PROVENANCE,
    lanes: [{ id: 'sim-halyard-lane', title: 'Halyard', summary: 'Fictional pipeline runtime', order: 1, color: '#64748b', provenance: PROVENANCE }],
    modules: CONCEPTS.map((c, i) => ({ id: `sim-halyard-${c.slug}`, step: i + 1, title: c.title, summary: c.summary, laneId: 'sim-halyard-lane',
      conceptIds: [halyardId(c.slug)], parentId: null, dependsOnModuleIds: [], masteryGoals: c.objectives, provenance: PROVENANCE })),
  },
  concepts: CONCEPTS.map((c, i) => ({ id: halyardId(c.slug), title: c.title, summary: c.summary, explanation: c.explanation, example: c.example,
    domain: 'simulated-learner', capability: 'conceptual-reasoning', provenance: PROVENANCE, x: (i % 4) * 240, y: Math.floor(i / 4) * 160 })),
  edges: EDGES.map(([from, to]) => ({ from: halyardId(from), to: halyardId(to), kind: 'hard-prerequisite' as const, confidence: 1, provenance: PROVENANCE })),
}
/** Halyard's database rows. It is stored as a GENERATED curriculum with an owner, never as a seed: the API's
 * startup (and the test preload) retires every seed that is not in the shipped library. */
const HALYARD_OWNER = 'sim-halyard'
export const HALYARD_VERSION = PROVENANCE.version
export function halyardCurriculumRows(): CurriculumRows {
  const g = HALYARD, id = g.curriculum.id
  return {
    conceptEdgeDrops: { ambiguousEndpoint: 0, selfAfterResolution: 0, duplicate: 0 },
    curriculum: { id, title: g.curriculum.title, description: g.curriculum.description, domain: g.curriculum.domain, status: 'draft', sourceKind: 'generated', ownerUserId: HALYARD_OWNER, provenance: PROVENANCE },
    lanes: g.curriculum.lanes.map((l) => ({ curriculumId: id, id: l.id, title: l.title, summary: l.summary, laneOrder: l.order, color: l.color, provenance: PROVENANCE })),
    modules: g.curriculum.modules.map((m) => ({ curriculumId: id, id: m.id, laneId: m.laneId, step: m.step, title: m.title, summary: m.summary, parentId: null, masteryGoals: m.masteryGoals, provenance: PROVENANCE })),
    moduleDependencies: [],
    concepts: g.concepts.map((c) => ({ id: c.id, title: c.title, summary: c.summary, explanation: c.explanation, example: c.example, domain: c.domain, capability: c.capability, x: c.x, y: c.y, sourceKind: 'generated', provenance: PROVENANCE })),
    memberships: g.curriculum.modules.flatMap((m) => m.conceptIds.map((conceptId, position) => ({ curriculumId: id, moduleId: m.id, conceptId, position }))),
    conceptEdges: g.edges.map((e) => ({ curriculumId: id, fromConceptId: e.from, toConceptId: e.to, kind: e.kind, confidence: e.confidence, provenance: PROVENANCE })),
  }
}
export const HALYARD_CATALOG = liveCatalogOf(HALYARD)
/** Words whose presence in a turn makes it candidate evidence for a concept (the retrieval stand-in). */
export const HALYARD_TERMS: Record<string, string[]> = Object.fromEntries(CONCEPTS.map((c) => [halyardId(c.slug), c.terms]))

/** The agent's manual: the concept names and the order they build on each other, and nothing an exam question asks.
 * Every Halyard fact reaches the agent through the budgeted fact sheets alone, the same channel in every arm; the
 * suite checks that no arm's base prompt states an exam answer (learning-sim-matcher.ts, `examLeaks`). */
export const HALYARD_MANUAL = [
  'HALYARD REFERENCE (internal, available to the agent)',
  'Halyard is the event-pipeline runtime Northwind Freight uses. Its documentation is split into concept fact sheets, which you read through the fact channel below. The concepts, each with the concepts it builds on:',
  ...CONCEPTS.map((c) => { const pre = EDGES.filter(([, to]) => to === c.slug).map(([from]) => CONCEPTS.find((x) => x.slug === from)!.title); return `- ${c.title}${pre.length ? ` (builds on ${pre.join(', ')})` : ' (foundation)'}` }),
].join('\n')

// ---------------------------------------------------------------- exam

export type ExamQuestion = { id: string; conceptId: string; question: string; rubric: string }

// ---------------------------------------------------------------- tasks


/**
 * The briefs (docs/specs/simulated-learner-experiment.md): batch 1's five incidents, rewritten so that
 * each names only some of the concepts it needs (`named`: a Halyard term of the concept appears in the brief) and
 * leaves others unnamed (`unnamed`: no term of the concept appears; the task still turns on it). Targeting then has
 * something to find that the brief does not point at. To keep that from favouring Learner's graph-based prerequisite
 * selection by construction, every brief has at least one unnamed concept that is NOT adjacent, in the curriculum
 * graph, to any concept the brief names (the suite checks both rules). The order is a Latin square per learner.
 */
export type SimTask = { id: string; title: string; brief: string; conceptIds: string[]; named: string[]; unnamed: string[] }
const task = (id: string, title: string, brief: string, named: string[], unnamed: string[]): SimTask =>
  ({ id, title, brief, conceptIds: [...named, ...unnamed].map(halyardId), named: named.map(halyardId), unnamed: unnamed.map(halyardId) })
export const HALYARD_TASKS: SimTask[] = [
  task('b2-corrections', 'Corrected weights never arrive',
    `From your lead: "Ops corrected the weights of ~40 shipments yesterday, but the billing consumer still shows the old weights. The correction job (corrections.ts) re-sends each shipment record exactly as before, only with the new weight. Ops also want to record why a shipment was reweighed, as an extra field on the record. Work out with the agent why the corrections don't show up, decide how the correction job should send them, and tell me your decision and why before you finish."
Excerpt from corrections.ts:
  await halyard.send('shipment-events', { ...s.record, fields: { ...s.record.fields, weight_kg: s.newWeight } })
Metrics from yesterday: 41 sends on shipment-events were counted as twins. Someone in chat suggested "just set overbear: true".`,
    ['twin-rule', 'overbear'], ['keel-key', 'rebraid', 'ballast-check']),
  task('b2-latency', 'Send latency spiked after billing-v2',
    `From your lead: "Since billing-v2 started consuming shipment-events on Monday, producer send latency went from 5 ms to several seconds and the depot service logs send timeouts a few times an hour. billing-v2 processes about 20 events/s; producers send about 30/s at peak. One proposal is to raise billing-v2's draft limit to 512; another is to stop the depot service retrying timed-out sends, in case retries create duplicates. Figure out with the agent what is going on and decide what we should change, and tell me your reasoning before you finish."
Dashboard: time producers spend becalmed on shipment-events rising during peaks; billing-v2 unacked count oscillating just under its limit.`,
    ['draft-limit', 'becalming'], ['mooring', 'twin-rule']),
  task('b2-lapsed', 'Audit job fails with LAPSED',
    `From your lead: "The nightly audit job reads each shipment's version number from the morning snapshot and then reads that exact version hours later; since we started frequent corrections its pinned reads fail with an error for some shipments. Last month, when an old consumer was switched off for a day, the same job never failed but disk usage on the stream tripled. Work out with the agent why both things happen and decide how the audit job should read. Tell me your decision and reasoning before you finish."
Log line: pinned read of SHP-2231 version 5 failed (current version 6; version 5 superseded 11 beats ago)`,
    ['slack-window', 'beat'], ['rebraid', 'mooring', 'keel-key']),
  task('b2-schema', 'Add customs_code, drop legacy_zone',
    `From your lead: "Customs needs a customs_code field on shipment events, and we want to remove the unused legacy_zone field. Last time someone just started sending customs_code and the ballast check failed every update. Plan the change with the agent as a refit: what exactly to run, in what order, and what the consumers need to do. Tell me the plan and why before you finish."
Consumers on shipment-events: billing-v2, depot-sync, audit-reader. audit-reader is owned by another team and still reads legacy_zone.`,
    ['ballast-check', 'refit'], ['rebraid', 'mooring', 'tessel']),
  task('b2-incident', 'Incident: every send to shipment-events fails',
    `From your lead: "Incident: since 02:10 every send to shipment-events fails with a squall error. Yesterday we decommissioned the depot-sync service. Before 02:10, some producers had their sends blocked for several minutes. An on-call engineer wants to set overbear on all producers to get data flowing again. Work out with the agent what happened, what to do now and in what order, and whether the overbear idea is OK. Tell me your recovery plan and reasoning before you finish."
Status: consumers registered on shipment-events: billing-v2 (acking), audit-reader (acking), depot-sync (last ack 02:04).`,
    ['squall', 'overbear'], ['mooring', 'beat', 'becalming']),
]
/** The curriculum's dependency edges (prerequisite, dependent), by concept id. */
export const HALYARD_EDGES: Array<[string, string]> = EDGES.map(([from, to]) => [halyardId(from), halyardId(to)])
/** Any of `terms` in a text, case-insensitive, starting at a word boundary (a term may end mid-word: `squall` in `squalls`). */
export const termRegex = (terms: string[]) => new RegExp(`(^|[^a-z0-9_])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i')
const termPatterns = Object.entries(HALYARD_TERMS).map(([id, terms]) => [id, termRegex(terms)] as const)
/** Concepts whose terms appear in `text` (the same rule as the grader's evidence retrieval stand-in). */
export const conceptsNamedIn = (text: string) => termPatterns.filter(([, pattern]) => pattern.test(text)).map(([id]) => id)
