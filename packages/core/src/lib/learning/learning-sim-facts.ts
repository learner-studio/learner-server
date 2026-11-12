/**
 * The calibration's fact sheets: eight atomic facts per concept, each tested by one question. One explanation
 * states all eight, so a learner that can take in only a few facts per session needs several explanations to
 * answer the whole exam: that is the headroom a dose-response needs. Facts extend the curriculum's own text
 * (learning-sim-halyard.ts) and never name another calibration concept.
 */
import { halyardId, type ExamQuestion } from './learning-sim-halyard.js'

type Fact = { fact: string; question: string; answer: string }
const sheet = (slug: string, title: string, facts: Fact[]) => ({ conceptId: halyardId(slug), title, facts })

const CALIBRATION_FACT_SHEETS = [
  sheet('keel-key', 'Keel key', [
    { fact: 'A keel key is the pair (origin, epoch) and is the identity of a tessel.', question: 'What two values make up a keel key?', answer: 'origin and epoch' },
    { fact: 'The origin is a stable business id chosen by the producer, such as a shipment id.', question: 'Who chooses a tessel\'s origin, and what kind of value is it?', answer: 'the producer; a stable business id (e.g. a shipment id)' },
    { fact: 'The epoch is an integer that starts at 1 for each origin.', question: 'At what number does the epoch start for a new origin?', answer: '1' },
    { fact: 'The current version of an origin is its tessel with the highest epoch.', question: 'Which tessel is the current version of an origin?', answer: 'the one with the highest epoch' },
    { fact: 'A reach orders tessels by epoch first.', question: 'What is the first sort key for tessels in a reach?', answer: 'epoch' },
    { fact: 'Tessels with equal epochs are ordered by origin, compared as text (lexicographically).', question: 'How are two tessels with the same epoch ordered?', answer: 'by origin, compared lexicographically (as text)' },
    { fact: 'Arrival time plays no part in the order, so a late tessel can sort before earlier arrivals.', question: 'Does arrival time affect the order of tessels in a reach?', answer: 'no; a late arrival can sort before earlier ones' },
    { fact: 'Two tessels with the same origin and epoch are called twins.', question: 'What are two tessels with the same origin and epoch called?', answer: 'twins' },
  ]),
  sheet('draft-limit', 'Draft limit', [
    { fact: 'The draft limit is the maximum number of unacknowledged tessels a mooring may hold.', question: 'What does a mooring\'s draft limit count?', answer: 'the maximum number of unacknowledged tessels it may hold' },
    { fact: 'The default draft limit is 64.', question: 'What is the default draft limit?', answer: '64' },
    { fact: 'When the unacknowledged count reaches the limit, producers lofting to that reach are becalmed: their lofts block.', question: 'What happens to producers when a mooring reaches its draft limit?', answer: 'they are becalmed: their lofts block' },
    { fact: 'Reaching the draft limit never drops or rejects tessels.', question: 'Are tessels dropped when a mooring reaches its draft limit?', answer: 'no; nothing is dropped or rejected' },
    { fact: 'Raising the draft limit costs memory on the mooring.', question: 'What resource does raising the draft limit cost?', answer: 'memory' },
    { fact: 'Raising the draft limit does not make the consumer process tessels faster.', question: 'Does raising the draft limit make a consumer process tessels faster?', answer: 'no' },
    { fact: 'A consumer slower than its producers reaches any draft limit eventually; a higher limit only delays it.', question: 'A consumer acks 20 tessels/s while producers loft 30/s. What does a higher draft limit achieve?', answer: 'it only delays reaching the limit; producers are becalmed eventually' },
    { fact: 'The draft limit is set per mooring, with `halyard mooring set <name> --draft N`.', question: 'Which command sets a mooring\'s draft limit?', answer: 'halyard mooring set <name> --draft N' },
  ]),
  sheet('refit', 'Refit', [
    { fact: 'A refit is a declared schema change for a reach, listing added and removed fields.', question: 'What is a refit?', answer: 'a declared schema change for a reach listing added and removed fields' },
    { fact: 'A refit has a refit window of at least 5 beats.', question: 'What is the minimum length of a refit window?', answer: '5 beats' },
    { fact: 'During the refit window rebraids with either the old or the new ballast are accepted.', question: 'Which ballasts are accepted during the refit window?', answer: 'both the old and the new ballast' },
    { fact: 'After the refit window only the new ballast is accepted.', question: 'Which ballast is accepted after the refit window ends?', answer: 'only the new ballast' },
    { fact: 'Each mooring declares which ballast it understands.', question: 'What does each mooring declare during a refit?', answer: 'which ballast it understands' },
    { fact: 'Removing a field requires every mooring to have declared the new ballast before the refit starts.', question: 'What must be true before a refit that removes a field can start?', answer: 'every mooring has declared the new ballast' },
    { fact: 'A field removal with an unready mooring is refused with the error MOORING_UNREADY.', question: 'What error refuses a field removal when a mooring is not ready?', answer: 'MOORING_UNREADY' },
    { fact: 'Adding a field has no readiness precondition.', question: 'Does adding a field require every mooring to be ready first?', answer: 'no' },
  ]),
  sheet('slack-window', 'Slack window', [
    { fact: 'A retired tessel stays readable for exactly 3 beats after the beat in which it was retired.', question: 'For how many beats after its retirement beat does a retired tessel stay readable?', answer: '3 beats' },
    { fact: 'A reader can pin an epoch: read origin X at epoch N.', question: 'What does it mean to pin a read?', answer: 'to read an origin at a specific epoch' },
    { fact: 'After the slack window a pinned read fails with the error LAPSED.', question: 'What error does a pinned read of a retired epoch get after the slack window?', answer: 'LAPSED' },
    { fact: 'An epoch retired at beat 120 can be read through beat 123 and fails from beat 124.', question: 'An epoch was retired at beat 120. What is the last beat at which a pinned read of it succeeds?', answer: '123' },
    { fact: 'The slack window is counted in beats, not wall-clock time.', question: 'Is the slack window measured in seconds or in beats?', answer: 'beats' },
    { fact: 'When beats stall the window stretches, so retired tessels stay readable longer.', question: 'What happens to the slack window when beats stall?', answer: 'it stretches; retired tessels stay readable longer' },
    { fact: 'A stretched slack window makes storage grow.', question: 'What resource grows when beats stall?', answer: 'storage' },
    { fact: 'A job that pins epochs must finish within 3 beats of the rebraid, or read the current epoch instead.', question: 'A job that pins epochs keeps failing with LAPSED. Name one fix.', answer: 'finish within 3 beats of the rebraid, or read the current epoch instead of pinning' },
  ]),
]

/** The other nine concepts' sheets: with the four above they make the main experiment's exam (13 x 8 = 104, 64 scored
 * questions), so no concept can be answered in full from two remembered facts. */
const MAIN_ONLY_FACT_SHEETS = [
  sheet('tessel', 'Tessel', [
    { fact: 'A tessel is the unit of data in Halyard.', question: 'What is the unit of data in Halyard called?', answer: 'a tessel' },
    { fact: 'A tessel has three parts: a keel key, a payload of named fields, and a ballast fingerprint.', question: 'Name the three parts of a tessel.', answer: 'keel key, payload of named fields, ballast fingerprint' },
    { fact: 'A tessel is immutable: it is never edited in place.', question: 'Can a tessel be edited in place?', answer: 'no; tessels are immutable' },
    { fact: 'Producers "loft" tessels into a reach.', question: 'What verb names a producer writing a tessel?', answer: 'loft' },
    { fact: 'A reach is a named stream of tessels.', question: 'What is a reach?', answer: 'a named stream of tessels' },
    { fact: 'Moorings are the consumers that read tessels from a reach.', question: 'What reads tessels from a reach?', answer: 'moorings' },
    { fact: 'Any change to an origin\'s data is a new tessel, called a rebraid.', question: 'What is a new tessel that changes an origin\'s data called?', answer: 'a rebraid' },
    { fact: 'Because tessels are immutable, two readers of the same keel key always see the same payload.', question: 'Why do two readers of the same keel key always see the same payload?', answer: 'because tessels are immutable' },
  ]),
  sheet('twin-rule', 'Twin rule', [
    { fact: 'A tessel whose keel key already exists in the reach is a twin and is discarded.', question: 'What happens to a tessel whose keel key already exists in the reach?', answer: 'it is a twin and is discarded' },
    { fact: 'A twin is dropped whatever its payload.', question: 'Does a twin with a different payload replace the original?', answer: 'no; a twin is dropped whatever its payload' },
    { fact: 'The first tessel to arrive with a given keel key wins.', question: 'Of two tessels with the same keel key, which one is kept?', answer: 'the first to arrive' },
    { fact: 'Dropping a twin raises no error: it is silent.', question: 'Does the producer get an error when its tessel is dropped as a twin?', answer: 'no; it is dropped silently' },
    { fact: 'Dropped twins are counted in the twins_dropped metric.', question: 'Which metric counts dropped twins?', answer: 'twins_dropped' },
    { fact: 'Re-lofting a corrected payload under the same epoch changes nothing.', question: 'A producer re-lofts a corrected payload under the same epoch. What do consumers read?', answer: 'still the original; nothing changes' },
    { fact: 'Retrying a loft after a timeout is always safe: the retry is either the first arrival or a dropped twin, never a duplicate.', question: 'Is it safe to retry a loft after a timeout, and why?', answer: 'yes; the retry is either the first arrival or a dropped twin, never a duplicate' },
    { fact: 'Only a tessel carrying the overbear flag escapes the twin rule.', question: 'Which flag lets a tessel escape the twin rule?', answer: 'overbear' },
  ]),
  sheet('overbear', 'Overbear', [
    { fact: 'Overbear is a flag that makes a tessel replace its twin instead of being dropped.', question: 'What does the overbear flag do?', answer: 'makes a tessel replace its twin instead of being dropped' },
    { fact: 'Only producers with the helm role may overbear.', question: 'Which role may send overbear tessels?', answer: 'helm' },
    { fact: 'An overbear replaces the tessel for future reads only.', question: 'Does an overbear change what readers already read?', answer: 'no; it affects future reads only' },
    { fact: 'Moorings that already read the original are not re-delivered the replacement.', question: 'Is the replacement re-delivered to moorings that already read the original?', answer: 'no' },
    { fact: 'Every overbear is written to the audit reach.', question: 'Where is every overbear recorded?', answer: 'the audit reach' },
    { fact: 'Overbear tessels are never becalmed.', question: 'Can an overbear tessel be becalmed?', answer: 'no' },
    { fact: 'During a squall overbear tessels are the only lofts accepted.', question: 'Which lofts are accepted during a squall?', answer: 'only overbear tessels' },
    { fact: 'Overbear is an emergency operator tool; a correction is published with a rebraid instead.', question: 'Should overbear be used to publish a data correction? If not, what should?', answer: 'no; use a rebraid (overbear is an emergency operator tool)' },
  ]),
  sheet('rebraid', 'Rebraid', [
    { fact: 'A rebraid is the only way to change an origin\'s data.', question: 'What is the only way to change an origin\'s data?', answer: 'a rebraid' },
    { fact: 'A rebraid lofts a new tessel with the same origin and exactly epoch + 1.', question: 'Which epoch must a rebraid use?', answer: 'exactly the previous epoch + 1' },
    { fact: 'Skipping epochs (epoch + 2 or more) is rejected with the error GAP.', question: 'What error rejects a rebraid that skips an epoch?', answer: 'GAP' },
    { fact: 'Reusing the same epoch is a twin, not a rebraid.', question: 'What is a tessel that reuses the current epoch?', answer: 'a twin' },
    { fact: 'After a rebraid the previous epoch is retired, not deleted.', question: 'What happens to the previous epoch after a rebraid?', answer: 'it is retired, not deleted' },
    { fact: 'A retired epoch stays readable during the slack window.', question: 'Can a retired epoch still be read right after a rebraid?', answer: 'yes, during the slack window' },
    { fact: 'Every rebraid passes the ballast check against the previous epoch.', question: 'Which check does every rebraid pass, and against what?', answer: 'the ballast check, against the previous epoch' },
    { fact: 'To correct SHP-1042 at epoch 3 you loft SHP-1042 epoch 4; lofting epoch 5 directly fails.', question: 'SHP-1042 is at epoch 3. Which epoch do you loft to correct it?', answer: '4' },
  ]),
  sheet('beat', 'Beat', [
    { fact: 'A beat is the logical clock of a reach.', question: 'What is a beat?', answer: 'the logical clock of a reach' },
    { fact: 'A beat advances only when every mooring has acknowledged every tessel lofted before that beat started.', question: 'When does a beat advance?', answer: 'when every mooring has acknowledged every tessel lofted before the beat started' },
    { fact: 'Beats are not timer ticks.', question: 'Are beats timer ticks?', answer: 'no' },
    { fact: 'A healthy reach advances about every 10 seconds.', question: 'About how often does a healthy reach advance a beat?', answer: 'about every 10 seconds' },
    { fact: 'One mooring that stops acknowledging stops the beat for the whole reach.', question: 'What does one mooring that stops acknowledging do to the reach?', answer: 'stops the beat for the whole reach' },
    { fact: 'An offline but still registered mooring also stops the beat.', question: 'Does an offline mooring that is still registered stop the beat?', answer: 'yes' },
    { fact: 'Everything measured in beats depends on the slowest mooring.', question: 'Which mooring sets the pace of everything measured in beats?', answer: 'the slowest mooring' },
    { fact: 'Logs show the current beat as beat=N.', question: 'How do logs show the current beat?', answer: 'beat=N' },
  ]),
  sheet('mooring', 'Mooring', [
    { fact: 'A mooring is a registered, durable consumer of a reach.', question: 'What is a mooring?', answer: 'a registered, durable consumer of a reach' },
    { fact: 'A mooring has a name, a draft limit and an acknowledgement position.', question: 'Name the three properties of a mooring.', answer: 'a name, a draft limit and an acknowledgement position' },
    { fact: 'A mooring exists until it is explicitly unmoored (deregistered).', question: 'How long does a mooring exist?', answer: 'until it is explicitly unmoored' },
    { fact: 'An offline mooring is still a mooring: its acknowledgement position does not move.', question: 'Is an offline consumer still a mooring?', answer: 'yes; its acknowledgement position stops moving' },
    { fact: 'An offline mooring still blocks beats.', question: 'Does an offline mooring block beats?', answer: 'yes' },
    { fact: 'Adding a mooring makes every beat on the reach depend on it.', question: 'What does adding a mooring do to the reach\'s beats?', answer: 'every beat now depends on it' },
    { fact: 'Retiring a consumer means unmooring it, not just stopping its process.', question: 'How do you retire a consumer properly?', answer: 'unmoor it, not just stop its process' },
    { fact: 'The command to deregister a mooring is halyard unmoor <name>.', question: 'Which command deregisters a mooring?', answer: 'halyard unmoor <name>' },
  ]),
  sheet('becalming', 'Becalming', [
    { fact: 'Becalming is Halyard\'s backpressure.', question: 'What is becalming?', answer: 'Halyard\'s backpressure' },
    { fact: 'While becalmed, loft calls block; they are not rejected and nothing is dropped.', question: 'While becalmed, are lofts blocked, rejected or dropped?', answer: 'blocked (not rejected, nothing dropped)' },
    { fact: 'Lofts resume only when the unacknowledged count falls below 75% of the draft limit.', question: 'At what level do becalmed lofts resume?', answer: 'below 75% of the draft limit' },
    { fact: 'With draft 64, lofts block at 64 unacknowledged tessels and resume below 48.', question: 'With a draft limit of 64, below what count do lofts resume?', answer: '48' },
    { fact: 'While becalmed, loft latency rises and the becalmed_ms metric climbs.', question: 'Which metric climbs while a producer is becalmed?', answer: 'becalmed_ms' },
    { fact: 'A producer whose loft timeout is shorter than the becalming gets LOFT_TIMEOUT.', question: 'What error does a producer get when its loft times out while becalmed?', answer: 'LOFT_TIMEOUT' },
    { fact: 'Retrying after LOFT_TIMEOUT is safe because of the twin rule.', question: 'Why is retrying after LOFT_TIMEOUT safe?', answer: 'because of the twin rule' },
    { fact: 'A producer becalmed for more than 10 minutes puts the reach into squall.', question: 'How long must a producer be becalmed to put the reach into squall?', answer: 'more than 10 minutes' },
  ]),
  sheet('ballast-check', 'Ballast check', [
    { fact: 'Each tessel carries a ballast fingerprint.', question: 'What fingerprint does each tessel carry?', answer: 'a ballast fingerprint' },
    { fact: 'The ballast is a hash of the tessel\'s sorted field NAMES.', question: 'What is the ballast a hash of?', answer: 'the sorted field names' },
    { fact: 'The ballast never depends on field values.', question: 'Does changing a field\'s value change the ballast?', answer: 'no' },
    { fact: 'Adding, removing or renaming a field always changes the ballast.', question: 'Which field changes always change the ballast?', answer: 'adding, removing or renaming a field' },
    { fact: 'A rebraid whose field set differs from the previous epoch is rejected with LISTING.', question: 'What error rejects a rebraid with a different field set?', answer: 'LISTING' },
    { fact: 'A different field set is accepted while a refit is active.', question: 'When is a rebraid with a different field set accepted?', answer: 'while a refit is active' },
    { fact: 'The check compares a rebraid with the previous epoch of the same origin.', question: 'What does the ballast check compare a rebraid with?', answer: 'the previous epoch of the same origin' },
    { fact: 'A brand-new origin (epoch 1) has nothing to compare with and is accepted.', question: 'Is the ballast checked for a brand-new origin at epoch 1?', answer: 'no; it has nothing to compare with and is accepted' },
  ]),
  sheet('squall', 'Squall', [
    { fact: 'A squall is a reach\'s failure mode.', question: 'What is a squall?', answer: 'a reach\'s failure mode' },
    { fact: 'A reach enters squall when beats stall for more than 30 beat intervals.', question: 'How long must beats stall for a reach to enter squall?', answer: 'more than 30 beat intervals' },
    { fact: 'A producer becalmed for more than 10 minutes also triggers a squall.', question: 'Besides stalled beats, what triggers a squall?', answer: 'a producer becalmed for more than 10 minutes' },
    { fact: 'In squall all non-overbear lofts are rejected immediately with SQUALL.', question: 'What happens to ordinary lofts during a squall?', answer: 'rejected immediately with SQUALL' },
    { fact: 'In squall lofts are rejected, not blocked.', question: 'During a squall, are lofts blocked or rejected?', answer: 'rejected' },
    { fact: 'In squall retired tessels are not expired.', question: 'Are retired tessels expired during a squall?', answer: 'no' },
    { fact: 'A squall never ends by itself: an operator runs halyard clear-squall after fixing the cause.', question: 'How does a squall end?', answer: 'an operator fixes the cause and runs halyard clear-squall' },
    { fact: 'Overbearing everything does not fix the stall and corrupts what moorings already read.', question: 'Does overbearing every loft fix a squall?', answer: 'no; it does not fix the stall and corrupts what moorings already read' },
  ]),
]

/**
 * Revision 8 (docs/specs/simulated-learner-experiment.md, "The exam"): items that can be answered without the
 * notebook are dropped from the sheets AND the exam (so no budget is spent on an unscored fact), fixed from the void
 * pilot 0946448d and probes 28f58f3b and c79a615f only, before any new data. Ids keep their original position.
 * - yesNo: the answer is yes or no, a 50% guess.
 * - shared: the answer is in material every arm sees (a task's title or brief, the agent's manual).
 * - ownQuestion: the answer is in its own question (a choice between named options).
 * - conceptName: the answer is a concept's name (every concept is named in the manual).
 * - otherQuestion: the answer is in the wording of another scored question.
 * - implied: follows from a delivered fact, as observed in those runs: keel-key-f8, twin-rule-f3 and twin-rule-f6
 *   from twin-rule-f1; overbear-f7 from squall-f4; refit-f5 from refit-f6.
 * The suite re-checks every rule but the last on the scored exam (learning-sim-rules.test.ts).
 */
export const DROPPED_EXAM_ITEMS = {
  yesNo: ['ballast-check-f3', 'ballast-check-f8', 'beat-f3', 'beat-f6', 'draft-limit-f4', 'draft-limit-f6', 'keel-key-f7', 'mooring-f4', 'mooring-f5', 'overbear-f3', 'overbear-f4', 'overbear-f6', 'overbear-f8', 'rebraid-f6', 'refit-f8', 'squall-f6', 'squall-f8', 'tessel-f3', 'twin-rule-f2', 'twin-rule-f4', 'twin-rule-f7'],
  shared: ['becalming-f2', 'keel-key-f8', 'rebraid-f1', 'rebraid-f4', 'slack-window-f3', 'slack-window-f5', 'tessel-f1', 'tessel-f7', 'twin-rule-f8'],
  ownQuestion: ['squall-f5'],
  conceptName: ['becalming-f7', 'tessel-f6'],
  otherQuestion: ['draft-limit-f2', 'keel-key-f5', 'tessel-f4'],
  implied: ['overbear-f7', 'refit-f5', 'twin-rule-f3', 'twin-rule-f6'],
} as const
const dropped = new Set<string>(Object.values(DROPPED_EXAM_ITEMS).flat())
const withIds = (s: { conceptId: string; title: string; facts: Fact[] }) => ({ conceptId: s.conceptId, title: s.title, facts: s.facts.map((f, i) => ({ ...f, id: `${s.conceptId.split('--')[1]}-f${i + 1}` })) })
/** All 104 items before revision 8's screen (the suite's positive control for the screen). */
export const HALYARD_FACT_ITEMS_UNSCREENED = [...CALIBRATION_FACT_SHEETS, ...MAIN_ONLY_FACT_SHEETS].map(withIds).flatMap((s) => s.facts.map((f) => ({ ...f, conceptId: s.conceptId })))
export const HALYARD_FACT_SHEETS = [...CALIBRATION_FACT_SHEETS, ...MAIN_ONLY_FACT_SHEETS].map(withIds).map((s) => ({ ...s, facts: s.facts.filter((f) => !dropped.has(f.id)) }))
const examOf = (sheets: typeof HALYARD_FACT_SHEETS): ExamQuestion[] => sheets.flatMap((s) => s.facts.map((f) => ({
  id: f.id, conceptId: s.conceptId, question: f.question,
  rubric: `2: the answer says ${f.answer}. 1: partly right or hedged between this and another answer. 0: otherwise, or "I don't know".`,
})))
/** The main experiment's exam: the single-fact questions of the 13 concepts not dropped above (64 of 104). */
export const HALYARD_FACT_EXAM: ExamQuestion[] = examOf(HALYARD_FACT_SHEETS)

/** The fact channel: one concept's sheet, each fact under its exam question's id (`<slug>-f<n>`). The agent sees
 * sheets only through this channel, the same in every arm (docs/specs/simulated-learner-experiment.md. */
export function factSheet(conceptId: string) {
  const s = HALYARD_FACT_SHEETS.find((x) => x.conceptId === conceptId)
  if (!s) throw new Error(`No fact sheet for ${conceptId}`)
  return { conceptId, title: s.title, facts: s.facts.map((f) => ({ id: f.id, fact: f.fact })) }
}
export type FactSheet = ReturnType<typeof factSheet>
