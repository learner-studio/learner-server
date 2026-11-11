import type { LearningGraph } from '../../functions/learning/learning-seed.js'
import type { CurriculumRows } from './curriculum-writer.js'
import { heldOutConcepts } from './learning-concept-holdout.js'
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
export const HALYARD_CURRICULUM_ID = 'sim-halyard'
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
export const HALYARD_OWNER = 'sim-halyard'
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
export const HALYARD_HELD_OUT: ReadonlySet<string> = heldOutConcepts(HALYARD_CATALOG.concepts)
/** Words whose presence in a turn makes it candidate evidence for a concept (the retrieval stand-in). */
export const HALYARD_TERMS: Record<string, string[]> = Object.fromEntries(CONCEPTS.map((c) => [halyardId(c.slug), c.terms]))

/** The reference the agent works from in EVERY arm, like a coding agent's own knowledge of a real tool.
 * Never shown to the learner, the exam scorer or the grader (the grader gets only its own concept's definition). */
export const HALYARD_MANUAL = [
  'HALYARD REFERENCE MANUAL (internal documentation available to the agent)',
  'Halyard is the event-pipeline runtime Northwind Freight uses. Producers loft tessels into reaches; moorings consume them. Commands: halyard loft, halyard unmoor <mooring>, halyard refit <reach> --add/--remove <field> --window <beats>, halyard clear-squall <reach>.',
  ...CONCEPTS.map((c) => `## ${c.title}\n${c.summary}\n${c.explanation}\nExample: ${c.example}`),
].join('\n\n')

// ---------------------------------------------------------------- exam

export type ExamQuestion = { id: string; conceptId: string; question: string; rubric: string }
const q = (slug: string, n: number, question: string, rubric: string): ExamQuestion => ({ id: `${slug}-${n}`, conceptId: halyardId(slug), question, rubric })

/** The closed-book exam: written once from the definitions above, never shown to the learner or the agent
 * during sessions, answered from the notebook only, scored 0-2 per question against the rubric. */
export const HALYARD_EXAM: ExamQuestion[] = [
  q('tessel', 1, 'In Halyard, what is a tessel made of?', '2: names all three: a keel key (identity), a payload of named fields, and a ballast fingerprint. 1: names two of them or describes it vaguely as an immutable record/message. 0: otherwise.'),
  q('tessel', 2, 'A teammate wants to fix a wrong value inside an existing tessel. How does Halyard handle changing data?', '2: tessels are immutable, never edited in place; you loft a new tessel (a rebraid, next epoch). 1: says it cannot be edited but not what to do instead, or says "send a new version" without immutability. 0: otherwise (e.g. update in place).'),
  q('tessel', 3, 'Why do two readers of the same keel key always see the same payload?', '2: because tessels are immutable, so the tessel under a keel key never changes (overbear aside is fine to mention). 1: partially correct or vague mention of versioning. 0: otherwise.'),
  q('keel-key', 1, 'What two values make up a tessel\'s identity?', '2: origin and epoch (the keel key). 1: names one of them correctly. 0: otherwise.'),
  q('keel-key', 2, 'Tessel A is SHP-7 epoch 2 and arrived last; tessel B is SHP-1 epoch 3 and arrived first. Which comes first in the reach order, and why?', '2: A first, because ordering is by epoch (2 < 3), not arrival time. 1: right answer with wrong/no reason, or states the rule without applying it. 0: otherwise.'),
  q('keel-key', 3, 'Two tessels both have epoch 5, with origins "SHP-9" and "SHP-10". Which sorts first?', '2: SHP-10, because equal epochs are ordered by origin lexicographically ("SHP-1..." < "SHP-9"). 1: says equal epochs are ordered by origin but picks SHP-9 or does not decide. 0: otherwise.'),
  q('twin-rule', 1, 'A producer lofts SHP-1042 epoch 3 with weight 812, then lofts SHP-1042 epoch 3 again with weight 790 (no flags). What do consumers read?', '2: 812; the second is a twin and is discarded silently (twins_dropped). 1: says the second is rejected/ignored without saying which value is read, or says an error is raised. 0: says 790 or otherwise.'),
  q('twin-rule', 2, 'A loft call timed out and the producer does not know whether it landed. Is it safe to retry, and why?', '2: yes; the retry has the same keel key, so if the first landed the retry is a dropped twin; no duplicate. 1: yes with a vague reason (idempotent) not tied to the keel key. 0: no, or otherwise.'),
  q('twin-rule', 3, 'Is a twin rejected with an error the producer can see?', '2: no, it is dropped silently (only a metric, twins_dropped, counts it). 1: says it is dropped but unsure about the error. 0: says it raises an error.'),
  q('overbear', 1, 'What does the overbear flag do?', '2: makes a tessel replace its twin (same keel key) instead of being dropped. 1: vague "force write/override". 0: otherwise.'),
  q('overbear', 2, 'The billing consumer already read SHP-9 epoch 4. An operator then overbears SHP-9 epoch 4. What does billing see?', '2: billing keeps the old payload; overbear affects future reads only and is not re-delivered to moorings that already read it. 1: says future reads change but unsure about billing. 0: says billing gets the new value.'),
  q('overbear', 3, 'A developer proposes using overbear for every correction. What is wrong with that?', '2: corrections should be rebraids (epoch+1); overbear is an audited operator/emergency tool needing the helm role, and consumers that already read the original are not re-delivered so they keep stale data. 1: one of these reasons. 0: otherwise.'),
  q('rebraid', 1, 'To correct SHP-1042 currently at epoch 3, what epoch must the new tessel have?', '2: 4 (exactly epoch + 1). 1: "a higher epoch" without exactly +1. 0: otherwise (e.g. 3).'),
  q('rebraid', 2, 'A producer lofts SHP-1042 epoch 6 when the current epoch is 4. What happens?', '2: rejected with GAP because epochs must increase by exactly one. 1: says rejected without the reason or error name. 0: accepted, or otherwise.'),
  q('rebraid', 3, 'What happens to the previous epoch after a rebraid?', '2: it is retired, not deleted, and stays readable for the slack window (3 beats) before pinned reads lapse. 1: says retired/kept for a while without detail. 0: deleted immediately, or otherwise.'),
  q('slack-window', 1, 'An epoch was retired at beat 120. Through which beat does a pinned read of it succeed, and what happens after?', '2: through beat 123; from beat 124 the pinned read fails with LAPSED. 1: says "3 beats" or LAPSED without the exact boundary. 0: otherwise.'),
  q('slack-window', 2, 'Is the slack window measured in seconds or beats, and what follows when beats stall?', '2: beats; when beats stall the window stretches, retired tessels stay readable longer and storage grows. 1: says beats but not the consequence. 0: otherwise.'),
  q('slack-window', 3, 'A nightly audit job pins epochs and sometimes fails with LAPSED. Give two ways to fix it.', '2: two of: finish within 3 beats of the rebraid / read the current epoch instead of pinning / pin closer to read time; mentions LAPSED means the retired epoch left the slack window. 1: one valid fix. 0: otherwise.'),
  q('beat', 1, 'What makes a beat advance in a reach?', '2: every mooring has acknowledged every tessel lofted before that beat started. 1: says it depends on consumer acknowledgements vaguely. 0: says a timer/every 10 s, or otherwise.'),
  q('beat', 2, 'One of three moorings crashes and stops acknowledging. What happens to beats on the reach?', '2: beats stop advancing for the whole reach, even though the other moorings keep reading. 1: says beats slow down or only that mooring is affected partially. 0: says nothing happens.'),
  q('beat', 3, 'Name two Halyard behaviours that depend on beats.', '2: two of: slack window/LAPSED, refit window, squall detection. 1: one. 0: none.'),
  q('mooring', 1, 'A team stops the process of an old consumer but does nothing else. Why can this still hurt the reach?', '2: the mooring is still registered (durable); its ack position does not move, so it blocks beats until unmoored. 1: says it is still registered without the beat effect, or vice versa. 0: otherwise.'),
  q('mooring', 2, 'What is the correct way to retire a consumer?', '2: unmoor (deregister) it, e.g. halyard unmoor <name>, not just stop its process. 1: says deregister vaguely. 0: otherwise.'),
  q('mooring', 3, 'What does adding a new mooring change for the existing reach?', '2: every beat now also waits for the new mooring\'s acknowledgements (it can stall beats / its draft limit can becalm producers). 1: vague "more load". 0: otherwise.'),
  q('draft-limit', 1, 'What is a mooring\'s draft limit and its default?', '2: the maximum unacknowledged tessels it may hold; default 64. 1: right meaning without the default, or the default without meaning. 0: otherwise.'),
  q('draft-limit', 2, 'A mooring acks 20 tessels/s while producers loft 30/s. Does raising its draft limit from 64 to 512 solve the problem?', '2: no; it only delays reaching the limit (more memory); the consumer is still slower than producers, so producers will be becalmed eventually. 1: says "partly/temporarily" without the reason. 0: says yes.'),
  q('draft-limit', 3, 'What happens when a mooring\'s unacknowledged count reaches its draft limit?', '2: producers lofting to that reach are becalmed (their lofts block). 1: says producers slow down vaguely. 0: says tessels are dropped or rejected.'),
  q('becalming', 1, 'While producers are becalmed, are their tessels rejected, dropped or something else?', '2: neither: loft calls block/wait until released; nothing is dropped. 1: says they are delayed without clarity. 0: rejected or dropped.'),
  q('becalming', 2, 'With a draft limit of 64, at what unacknowledged count do becalmed lofts resume?', '2: below 48 (75% of the draft limit). 1: says "below the limit with some margin" or 75% without the number. 0: 63/64 or otherwise.'),
  q('becalming', 3, 'A producer\'s loft times out with LOFT_TIMEOUT during becalming. What should it do?', '2: retry the same tessel (same keel key); safe because of the twin rule; or raise its timeout. 1: retry without the reason. 0: change the epoch or drop it.'),
  q('ballast-check', 1, 'What is a ballast fingerprint computed from?', '2: the sorted field NAMES of the tessel (not values). 1: says from the schema/fields without the names-not-values distinction. 0: from the values or checksum of content.'),
  q('ballast-check', 2, 'A rebraid changes weight_kg from 812 to 790 and nothing else. Does it pass the ballast check?', '2: yes; only field names count, values never trip it. 1: yes without reason. 0: no.'),
  q('ballast-check', 3, 'A rebraid adds a new field reweigh_reason. What happens if no refit is active?', '2: rejected with LISTING because the field set (ballast) differs from the previous epoch. 1: rejected without the reason or error name. 0: accepted.'),
  q('refit', 1, 'What is a refit and what is its minimum window?', '2: a declared schema change listing added/removed fields with a window of at least 5 beats during which old and new ballasts are accepted. 1: right idea without the minimum, or vague. 0: otherwise.'),
  q('refit', 2, 'Why might a refit that REMOVES a field be refused, when one that adds a field is not?', '2: removing requires every mooring to have declared the new ballast before the refit starts; otherwise MOORING_UNREADY. Adding has no such precondition. 1: partial. 0: otherwise.'),
  q('refit', 3, 'What is accepted after the refit window ends?', '2: only the new ballast. 1: vague "the new schema" with uncertainty. 0: both, or otherwise.'),
  q('squall', 1, 'What two conditions put a reach into squall?', '2: beats stalled for more than 30 beat intervals, and a producer becalmed continuously for more than 10 minutes. 1: one of them. 0: otherwise.'),
  q('squall', 2, 'During a squall, what happens to an ordinary (non-overbear) loft?', '2: rejected immediately with SQUALL (not blocked). 1: says rejected without the immediate/not-blocked distinction. 0: blocked like becalming, or accepted.'),
  q('squall', 3, 'After you fix the cause of a squall, does the reach recover by itself?', '2: no; an operator must run halyard clear-squall after fixing the cause. 1: says manual action is needed without naming it. 0: yes.'),
]

// ---------------------------------------------------------------- tasks

export type SimTask = { id: string; title: string; brief: string; conceptIds: string[] }
const task = (id: string, title: string, brief: string, slugs: string[]): SimTask => ({ id, title, brief, conceptIds: slugs.map(halyardId) })

/** Five sessions, the same sequence in every arm. Each brief is what the learner's lead sent; the agent sees the
 * same brief. Every concept is exercised by at least one task; held-out concepts as often as their neighbours. */
export const HALYARD_TASKS: SimTask[] = [
  task('s1-corrections', 'Corrected weights never arrive',
    `From your lead: "Ops corrected the weights of ~40 shipments yesterday, but the billing consumer still shows the old weights. The correction job (corrections.ts) re-sends each shipment with the new weight. Ops also want to record why a shipment was reweighed, maybe as a new reweigh_reason field. Work out with the agent why the corrections don't show up, decide how the correction job should send them, and tell me your decision and why before you finish."
Excerpt from corrections.ts:
  await halyard.loft('shipment-events', { origin: s.id, epoch: s.epoch, fields: { ...s.fields, weight_kg: s.newWeight } })
Metrics from yesterday: twins_dropped +41 on shipment-events. Someone in chat suggested "just set overbear: true".`,
    ['tessel', 'keel-key', 'twin-rule', 'rebraid', 'overbear', 'ballast-check']),
  task('s2-latency', 'Loft latency spiked after billing-v2',
    `From your lead: "Since billing-v2 started consuming shipment-events on Monday, producer loft latency went from 5 ms to several seconds and the depot service logs LOFT_TIMEOUT a few times an hour. billing-v2 processes about 20 tessels/s; producers send about 30/s at peak. One proposal is to raise billing-v2's draft from 64 to 512. Figure out with the agent what is going on and decide what we should change, and tell me your reasoning before you finish."
Dashboard: becalmed_ms on shipment-events rising during peaks; billing-v2 unacked count oscillating between 48 and 64; beat interval normal (~10 s) off-peak.`,
    ['mooring', 'draft-limit', 'becalming', 'beat', 'twin-rule']),
  task('s3-lapsed', 'Audit job fails with LAPSED',
    `From your lead: "The nightly audit job reads each shipment's epoch from the morning snapshot and then reads that exact epoch hours later; since we started frequent corrections it fails with LAPSED for some shipments. Last month, when an old consumer was offline for a day, the same job never failed but disk usage on the reach tripled. Work out with the agent why both things happen and decide how the audit job should read. Tell me your decision and reasoning before you finish."
Log line: read SHP-2231@epoch=5 -> LAPSED (current epoch 6, retired at beat=88120, now beat=88131)`,
    ['rebraid', 'slack-window', 'beat', 'mooring', 'keel-key']),
  task('s4-refit', 'Add customs_code, drop legacy_zone',
    `From your lead: "Customs needs a customs_code field on shipment events, and we want to remove the unused legacy_zone field. Last time someone just started sending the new field and every update failed with LISTING. Plan the change with the agent: what exactly to run, in what order, and what the consumers need to do. Tell me the plan and why before you finish."
Consumers on shipment-events: billing-v2, depot-sync, audit-reader. audit-reader is owned by another team and still reads legacy_zone.`,
    ['ballast-check', 'refit', 'mooring', 'rebraid', 'tessel']),
  task('s5-squall', 'Incident: shipment-events in squall',
    `From your lead: "Incident: since 02:10 every loft to shipment-events fails with SQUALL. The beat has been stuck at 91002 since 02:04. Yesterday we decommissioned the depot-sync service. An on-call engineer wants to set overbear on all producers to get data flowing again. Work out with the agent what happened, what to do now and in what order, and whether the overbear idea is OK. Tell me your recovery plan and reasoning before you finish."
Status: moorings on shipment-events: billing-v2 (acking), audit-reader (acking), depot-sync (last ack 02:04). Some producers were also becalmed for a while before 02:10.`,
    ['squall', 'beat', 'mooring', 'overbear', 'becalming', 'slack-window', 'draft-limit']),
]

/**
 * Batch 2's briefs (docs/specs/simulated-learner-experiment.md, "Batch 2"): the same five incidents, rewritten so that
 * each names only some of the concepts it needs (`named`: a Halyard term of the concept appears in the brief) and
 * leaves others unnamed (`unnamed`: no term of the concept appears; the task still turns on it). Targeting then has
 * something to find that the brief does not point at. To keep that from favouring Learner's graph-based prerequisite
 * selection by construction, every brief has at least one unnamed concept that is NOT adjacent, in the curriculum
 * graph, to any concept the brief names (the suite checks both rules). The order is a Latin square per learner.
 */
export type SimTaskV2 = SimTask & { named: string[]; unnamed: string[] }
const taskV2 = (id: string, title: string, brief: string, named: string[], unnamed: string[]): SimTaskV2 =>
  ({ ...task(id, title, brief, [...named, ...unnamed]), named: named.map(halyardId), unnamed: unnamed.map(halyardId) })
export const HALYARD_TASKS_V2: SimTaskV2[] = [
  taskV2('b2-corrections', 'Corrected weights never arrive',
    `From your lead: "Ops corrected the weights of ~40 shipments yesterday, but the billing consumer still shows the old weights. The correction job (corrections.ts) re-sends each shipment record exactly as before, only with the new weight. Ops also want to record why a shipment was reweighed, as an extra field on the record. Work out with the agent why the corrections don't show up, decide how the correction job should send them, and tell me your decision and why before you finish."
Excerpt from corrections.ts:
  await halyard.send('shipment-events', { ...s.record, fields: { ...s.record.fields, weight_kg: s.newWeight } })
Metrics from yesterday: twins_dropped +41 on shipment-events. Someone in chat suggested "just set overbear: true".`,
    ['twin-rule', 'overbear'], ['keel-key', 'rebraid', 'ballast-check']),
  taskV2('b2-latency', 'Send latency spiked after billing-v2',
    `From your lead: "Since billing-v2 started consuming shipment-events on Monday, producer send latency went from 5 ms to several seconds and the depot service logs send timeouts a few times an hour. billing-v2 processes about 20 events/s; producers send about 30/s at peak. One proposal is to raise billing-v2's draft from 64 to 512; another is to stop the depot service retrying timed-out sends, in case retries create duplicates. Figure out with the agent what is going on and decide what we should change, and tell me your reasoning before you finish."
Dashboard: becalmed_ms on shipment-events rising during peaks; billing-v2 unacked count oscillating between 48 and 64.`,
    ['draft-limit', 'becalming'], ['mooring', 'twin-rule']),
  taskV2('b2-lapsed', 'Audit job fails with LAPSED',
    `From your lead: "The nightly audit job reads each shipment's version number from the morning snapshot and then reads that exact version hours later; since we started frequent corrections it fails with LAPSED for some shipments. Last month, when an old consumer was switched off for a day, the same job never failed but disk usage on the stream tripled. Work out with the agent why both things happen and decide how the audit job should read. Tell me your decision and reasoning before you finish."
Log line: read SHP-2231@v5 -> LAPSED (current v6, superseded at beat=88120, now beat=88131)`,
    ['slack-window', 'beat'], ['rebraid', 'mooring', 'keel-key']),
  taskV2('b2-schema', 'Add customs_code, drop legacy_zone',
    `From your lead: "Customs needs a customs_code field on shipment events, and we want to remove the unused legacy_zone field. Last time someone just started sending the new field and every update failed with LISTING. Plan the change with the agent as a refit: what exactly to run, in what order, and what the consumers need to do. Tell me the plan and why before you finish."
Consumers on shipment-events: billing-v2, depot-sync, audit-reader. audit-reader is owned by another team and still reads legacy_zone.`,
    ['ballast-check', 'refit'], ['rebraid', 'mooring', 'tessel']),
  taskV2('b2-incident', 'Incident: every send to shipment-events fails',
    `From your lead: "Incident: since 02:10 every send to shipment-events fails with SQUALL. Yesterday we decommissioned the depot-sync service. Before 02:10, some producers had their sends blocked for several minutes. An on-call engineer wants to set overbear on all producers to get data flowing again. Work out with the agent what happened, what to do now and in what order, and whether the overbear idea is OK. Tell me your recovery plan and reasoning before you finish."
Status: consumers registered on shipment-events: billing-v2 (acking), audit-reader (acking), depot-sync (last ack 02:04).`,
    ['squall', 'overbear'], ['mooring', 'beat', 'becalming']),
]
/** The curriculum's dependency edges (prerequisite, dependent), by concept id. */
export const HALYARD_EDGES: Array<[string, string]> = EDGES.map(([from, to]) => [halyardId(from), halyardId(to)])
/** Concepts whose terms appear in `text` (the same rule as the grader's evidence retrieval stand-in). */
export const conceptsNamedIn = (text: string) => Object.entries(HALYARD_TERMS)
  .filter(([, terms]) => new RegExp(`(^|[^a-z0-9_])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i').test(text)).map(([id]) => id)
