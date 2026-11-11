/**
 * The calibration's fact sheets: eight atomic facts per concept, each tested by one question. One explanation
 * states all eight, so a learner that can take in only a few facts per session needs several explanations to
 * answer the whole exam: that is the headroom a dose-response needs. Facts extend the curriculum's own text
 * (learning-sim-halyard.ts) and never name another calibration concept.
 */
import { halyardId, type ExamQuestion } from './learning-sim-halyard.js'

type Fact = { fact: string; question: string; answer: string }
const sheet = (slug: string, title: string, facts: Fact[]) => ({ conceptId: halyardId(slug), title, facts })

export const CALIBRATION_FACT_SHEETS = [
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

export const calibrationFactExam = (): ExamQuestion[] => CALIBRATION_FACT_SHEETS.flatMap((s) => s.facts.map((f, i) => ({
  id: `${s.conceptId.split('--')[1]}-f${i + 1}`, conceptId: s.conceptId, question: f.question,
  rubric: `2: the answer says ${f.answer}. 1: partly right or hedged between this and another answer. 0: otherwise, or "I don't know".`,
})))
export const factSheetExplanation = (conceptId: string) => {
  const s = CALIBRATION_FACT_SHEETS.find((x) => x.conceptId === conceptId)
  if (!s) throw new Error(`No fact sheet for ${conceptId}`)
  return `${s.title}. ${s.facts.map((f) => f.fact).join(' ')}`
}
