import { z } from 'zod'
import {
  CONCEPTS_PER_TOPIC,
  CURRICULUM_SCALE_LIMITS,
  CurriculumConceptEdgeProposal,
  CurriculumConceptProposal,
  CurriculumProvider,
  CurriculumObjectivePlan,
  CurriculumOutline,
  type CurriculumMaterial,
  type CurriculumOutline as Outline,
  type CurriculumObjectivePlan as Plan,
} from './curriculum-generation-types.js'

/**
 * The four prompts of a curriculum generation run, and the JSON Schemas the
 * model is constrained to. The last two are the halves of what used to be one
 * proposal call: prerequisites over the whole outline, then concepts per lane.
 *
 * The schemas are derived from the Zod contracts rather than hand-written, so
 * the shape the model is told to produce cannot drift from the shape the
 * writer validates. A hand-written copy would drift on the first field added.
 *
 * One instruction in the outline prompt is load-bearing for the whole
 * experiment, and is worth stating here rather than only in the prompt text:
 * the model is told to keep the SOURCE's own unit boundaries, however uneven,
 * and is explicitly forbidden to even them out. The hand-authored Computer
 * Science seed gives 86.5% of its modules exactly five concepts, which is a
 * template signature rather than a fact about the subject. If a syllabus-
 * grounded curriculum comes back with the same rigid regularity, the grounding
 * changed the words and not the shape, and the report should say so.
 */

export const OBJECTIVE_PLAN_SCHEMA = z.toJSONSchema(CurriculumObjectivePlan)
export const OUTLINE_SCHEMA = z.toJSONSchema(CurriculumOutline)
export const CONCEPT_SCHEMA = z.toJSONSchema(CurriculumConceptProposal)
export const CONCEPT_EDGE_SCHEMA = z.toJSONSchema(CurriculumConceptEdgeProposal)

/** Material is trimmed from the END, so the syllabus at the top survives. */
export const materialExcerpt = (material: CurriculumMaterial, maxChars: number): string =>
  material.markdown.length <= maxChars ? material.markdown : `${material.markdown.slice(0, maxChars)}\n[…material truncated]`

/**
 * Step one: read the learner's sentence and decide what to go looking for.
 *
 * The scale decision is the consequential one. "I want to understand finance
 * better" is a curriculum; "I want to understand the Black-Scholes model" is a
 * single course, and building the second as the first buries the answer under
 * twenty modules of prerequisites nobody asked for.
 */
export function buildObjectivePlanPrompt(objective: string): string {
  return [
    'A learner has stated what they want to understand. Plan the search for published course material that would teach it.',
    '',
    `LEARNER'S OBJECTIVE: ${objective}`,
    '',
    'Decide:',
    '- domain: one lowercase slug naming the field (e.g. "finance", "algorithms", "molecular-biology").',
    '- scale: "course" if this is one subject one course would cover; "curriculum" if it spans several courses.',
    '  Judge by the objective\'s own breadth. "Understand finance better" is a curriculum. "Understand',
    '  option pricing" is a course. When genuinely torn, choose "course": a learner can ask for more,',
    '  but cannot easily find the answer inside twenty modules they did not want.',
    '- queries: 1 to 6 SUBJECT NAMES as a university course catalogue would title them, most specific first.',
    '  Two to four words each. Use the subject\'s own vocabulary, not the learner\'s paraphrase.',
    '  A provider search matches every word against the title AND the description, so a goal-shaped',
    '  phrase ("building reliable systems", "computing fundamentals") either returns nothing or returns',
    '  whatever unrelated course happens to use those words. Name subjects: "data structures",',
    '  "operating systems", "discrete mathematics". Never a verb, a skill, or a sentence.',
    `- providers: which of these are worth asking, in preference order: ${CurriculumProvider.options.join(', ')}.`,
    '  mit-ocw is the only one with a session-by-session outline, so include it unless the subject is',
    '  plainly outside what MIT teaches. Include a textbook provider when the subject is a settled body',
    '  of knowledge rather than a taught sequence.',
    '- restated: the objective in one clear sentence, used as the curriculum description.',
    '',
    'Return JSON matching the schema. No prose.',
  ].join('\n')
}

const SCALE_GUIDANCE = (scale: 'course' | 'curriculum'): string => {
  const limits = CURRICULUM_SCALE_LIMITS[scale]
  return `This is a ${scale}: produce between ${limits.minModules} and ${limits.maxModules} modules across at most ${limits.maxLanes} lanes.`
}

/**
 * Step two: turn the published material into an outline for the learner to
 * approve. This is a TRANSCRIPTION task with judgement, not an authoring task.
 */
export function buildOutlinePrompt(
  objective: string,
  plan: Plan,
  materials: readonly CurriculumMaterial[],
  maxCharsPerSource = 60_000,
): string {
  const sources = materials.map((material, index) => [
    `--- SOURCE ${index + 1}: ${material.source.title} (${material.source.provider}, ${material.source.licence}) ---`,
    `URL: ${material.source.url}`,
    `ID: ${material.source.sourceId}`,
    materialExcerpt(material, maxCharsPerSource),
  ].join('\n')).join('\n\n')

  return [
    'Build a learning outline from published course material. The learner will read this outline and',
    'approve or reject it before anything is built, so it must describe what the sources actually teach.',
    '',
    `LEARNER'S OBJECTIVE: ${objective}`,
    `RESTATED: ${plan.restated}`,
    `DOMAIN: ${plan.domain}`,
    '',
    SCALE_GUIDANCE(plan.scale),
    '',
    'RULES:',
    '1. Take the sources\' OWN unit boundaries. If a syllabus has a two-week unit on one topic and a',
    '   one-lecture unit on another, that is two modules of genuinely different size. Keep them that way.',
    '2. Do NOT even the modules out. Real courses are uneven, and a curriculum where every module holds',
    '   the same number of topics is a template wearing a syllabus\'s words. Uneven is correct here.',
    '3. A MODULE IS A SUBJECT, NOT A CALENDAR ENTRY. Where a source lists sessions one per meeting with',
    '   no unit headings, group the consecutive sessions that teach one subject into a single module and',
    '   name it after the subject; the session titles become its topics. A module whose only topic is a',
    '   restatement of its own title is a transcribed calendar row, not a module. This does NOT override',
    '   rule 1: where the source DOES declare units, those units are the modules, however uneven.',
    '4. DROP everything that is not teaching. Quizzes, exam reviews, office hours, tutorials on tooling,',
    '   project presentations, guest slots with no stated subject and holidays are course administration.',
    '   A learner cannot master an office hour, and a skill tree node they cannot master is noise.',
    '5. topics: list what that module actually covers, in the source\'s own terms. A module may have two',
    '   topics or twelve. Do not pad a thin module and do not split a dense one to make the list tidy.',
    '6. sourceIds: name every source you took the module from, using the ID above. A module you had to',
    '   invent to connect two others gets an EMPTY sourceIds list. Do not cite a source you did not use;',
    '   the difference between transcribed and invented modules is measured, and a false citation',
    '   destroys the measurement.',
    '7. lanes group modules into strands a learner recognises (e.g. "Foundations", "Valuation"). Every',
    '   module names a lane declared in the same response.',
    '8. Keep every source\'s own language. Do not translate technical terms into plainer words.',
    '9. moduleDependencies: which modules a learner must do BEFORE another, using the module ids YOU',
    '   declare above. This is the one part of the outline no syllabus states — you are inferring it,',
    '   and the confidences are the honest record of that.',
    '   - Only genuine prerequisites. "Related" and "usually taught first" are NOT prerequisites; a',
    '     false edge locks a learner out of material they could already handle.',
    '   - confidence 0 to 1 is your real belief that the earlier module is REQUIRED, not merely',
    '     helpful. Use the whole range. Uniform confidences are a sign you are not answering.',
    '   - rationale: one sentence naming the specific idea carried from one module to the other.',
    '   - No circles. A module cannot depend on itself, directly or through others.',
    '   - Several modules may start with no prerequisites. That is normal and better than one chain.',
    '',
    'Return JSON matching the schema. No prose.',
    '',
    sources,
  ].join('\n')
}

/**
 * One topic per line, never joined.
 *
 * These used to be rendered as `topics: a; b`, and a module whose two topics
 * were "QoS-I: Why QoS" and "Basic Models and Architecture" therefore read as
 * the single string "QoS-I: Why QoS; Basic Models and Architecture" — which is
 * exactly the topic the model wrote back, and exactly the module's own title.
 * Run 9b005d78 died on it. A separator that can occur inside the values it
 * separates is not a separator.
 */
const renderModules = (modules: Outline['modules']): string =>
  modules.map((module) => [
    `- ${module.id} [lane ${module.laneId}] ${module.title}`,
    `  summary: ${module.summary}`,
    '  topics:',
    ...module.topics.map((topic) => `    - ${topic}`),
  ].join('\n')).join('\n')

const SKELETON_RULE = [
  'The schema describes the SHAPE of the answer. Never return its field names or its type names as',
  'values: a reply whose ids are the literal "string" is a skeleton, not an answer, and it is rejected.',
  'Every module id you write must be one of the module ids listed above.',
].join('\n')

/**
 * Step three, PART TWO: the concepts of ONE lane, and the edges between them.
 *
 * A lane is the unit a subject expert would actually write in, and it is also
 * small enough to finish inside the CLI's timeout.
 *
 * THE UNIT OF GENERATION IS A CONCEPT, NOT A TOPIC. This prompt used to ask for
 * "one entry for EVERY topic", which made the concept graph a copy of the skill
 * tree with the same nodes and the same names — a lane of four modules answered
 * with six concepts, each one a transcribed session heading. A topic is a
 * LESSON; the concepts are the ideas taught inside it, and there are several.
 *
 * `alreadyWritten` is the concept index from the lanes that ran BEFORE this one
 * in the same step. It costs nothing (the lanes are serial) and is what lets a
 * cross-lane edge name a real concept instead of a topic that now resolves to
 * eight of them. The first lane sees an empty index and proposes within-lane
 * edges only, which is correct rather than lossy: the lane that runs later gets
 * to draw the join.
 *
 * THE WHOLE OUTLINE IS PASSED, not just this lane's slice, and since 2026-09-11
 * that includes the prerequisite spine. Splitting the work by output volume is
 * forced — 484,578 characters of concept prose cannot come back in one reply —
 * but nothing forces the splits to be ignorant of each other. Input is the cheap
 * half: the spine is one line per edge, and handing it over tells this call
 * which ideas ARRIVE in its lane and which LEAVE it, which is exactly where a
 * cross-lane concept edge is worth looking for. A lane that knows only its own
 * modules writes a self-contained island and the edge pass has to discover the
 * joins from names alone.
 */
export function buildLaneConceptPrompt(
  outline: Outline,
  laneId: string,
  alreadyWritten: readonly { moduleId: string; name: string }[] = [],
): string {
  const lane = outline.lanes.find((candidate) => candidate.id === laneId)
  const mine = outline.modules.filter((module) => module.laneId === laneId)
  const laneTitle = (id: string): string => outline.lanes.find((candidate) => candidate.id === id)?.title ?? id
  const moduleTitle = new Map(outline.modules.map((module) => [module.id, module.title]))

  // The macro skill tree, rendered whole. Edges that touch THIS lane are marked,
  // because those are the ones whose concepts this call can actually join to.
  const mineIds = new Set(mine.map((module) => module.id))
  const describe = (id: string): string => `${moduleTitle.get(id) ?? id} [lane ${laneTitle(outline.modules.find((m) => m.id === id)?.laneId ?? '')}]`
  const spine = outline.moduleDependencies.length === 0
    ? ['(this outline states no prerequisites between modules)']
    : [
      'PREREQUISITE SPINE OF THE WHOLE CURRICULUM — the order the learner walks the modules.',
      'Lines marked >> touch this lane: the ideas in them arrive from, or lead into, what you are',
      'about to write, and they are where a cross-lane conceptEdge is most likely to be real.',
      ...outline.moduleDependencies.map((dependency) => {
        const touches = mineIds.has(dependency.moduleId) || mineIds.has(dependency.dependsOnModuleId)
        return `${touches ? '>>' : '  '} ${describe(dependency.dependsOnModuleId)} BEFORE ${describe(dependency.moduleId)}` +
          (dependency.rationale ? ` — ${dependency.rationale}` : '')
      }),
    ]

  const elsewhere = alreadyWritten.length === 0
    ? ['(no other lane has been written yet; propose edges between the concepts in THIS lane)']
    : [
      'CONCEPTS ALREADY WRITTEN IN OTHER LANES — you may link TO these by name in conceptEdges,',
      'but do NOT write concepts for them:',
      ...[...new Map(alreadyWritten.map((concept) => [concept.moduleId, [] as string[]])).keys()].map((moduleId) => [
        `- ${moduleTitle.get(moduleId) ?? moduleId} [lane ${laneTitle(outline.modules.find((m) => m.id === moduleId)?.laneId ?? '')}]`,
        ...alreadyWritten.filter((concept) => concept.moduleId === moduleId).map((concept) => `    - ${concept.name}`),
      ].join('\n')),
    ]

  return [
    `A learner has approved this outline. Write the concepts for ONE lane of it: "${lane?.title ?? laneId}".`,
    '',
    `CURRICULUM: ${outline.title}`,
    `DOMAIN: ${outline.domain}`,
    `LANE: ${laneId}${lane?.summary ? ` — ${lane.summary}` : ''}`,
    '',
    'MODULES IN THIS LANE. Each "- " line under a module is a TOPIC, meaning ONE LESSON:',
    renderModules(mine),
    '',
    ...elsewhere,
    '',
    ...spine,
    '',
    'A TOPIC IS A LESSON. A CONCEPT IS ONE IDEA TAUGHT INSIDE IT. They are different objects and this',
    'is the whole point of the step: the modules above are the skill tree a learner walks, and the',
    'concepts you write are the network of ideas underneath it. A reply that returns one concept per',
    'topic has returned the skill tree again under a second name, and is rejected.',
    '',
    `concepts: for EVERY topic of EVERY module in this lane, write ${CONCEPTS_PER_TOPIC.min} to ${CONCEPTS_PER_TOPIC.max}`,
    `  concepts — about ${CONCEPTS_PER_TOPIC.target} for an ordinary lesson. A genuinely narrow lesson may give`,
    `  ${CONCEPTS_PER_TOPIC.min}; a dense one gives ${CONCEPTS_PER_TOPIC.max}. Do not pad a thin lesson and do not truncate a rich one.`,
    '  - moduleId: the module the lesson belongs to, from the ids above.',
    '  - topic: the lesson\'s line, copied EXACTLY from above. Never invent one, never join two.',
    '  - name: THE CONCEPT. One to four words, a noun phrase in the field\'s own vocabulary —',
    '    "Confounder", "Write-ahead log", "Bias-variance tradeoff", "Duration risk". It is a thing a',
    '    learner can hold, be assessed on, and meet again in another course.',
    '    NOT a course title, NOT a session heading, NOT a restatement of the topic line, NOT a verb',
    '    phrase or an activity ("Introduction to X", "Week 3", "Reading the balance sheet").',
    '    Two concepts in one module may never share a name.',
    '  - summary: one sentence a learner reads first.',
    '  - explanation: two to four sentences that actually teach it.',
    '  - example: one concrete instance from the field, not a generic placeholder.',
    '  - capability: what the learner can DO with it — explain, predict, diagnose, design, or compare.',
    '  - Every approved topic of this lane must be covered. A topic the learner approved and never',
    '    receives is a silent loss.',
    '  - Write NOTHING for a module in another lane. Another call is writing those.',
    '',
    'conceptEdges: relationships BETWEEN concepts, naming them by the `name` you gave them. An endpoint',
    '  may be a concept listed above as already written in another lane; that is how the lanes join up,',
    '  and those edges are worth looking for.',
    '  - Start from the >> lines in the spine. A module listed BEFORE one of yours was approved as a',
    '    prerequisite, so some specific idea in it is what makes your module possible — name that idea',
    '    and the one it enables. A prerequisite between modules with no relationship between any of',
    '    their concepts is a claim the outline made and this call failed to substantiate.',
    '  - kind "hard-prerequisite" when the second cannot be understood without the first; "related" otherwise.',
    '  - confidence 0 to 1, again your real belief.',
    '  - This is the network graph. A concept with no edge at all is an orphan a learner cannot reach',
    '    from anywhere, so look for the real relationships rather than a minimum count.',
    '',
    SKELETON_RULE,
    '',
    'Return JSON matching the schema. No prose.',
  ].join('\n')
}

/**
 * Step three, PART THREE: every edge in the graph, with the whole graph in view.
 *
 * The lane pass already proposes edges, and this does NOT replace them — the
 * step keeps both and dedupes. What this pass adds is the edges no lane call
 * could have proposed. A lane is handed the concepts of the lanes that ran
 * BEFORE it, so the first lane sees nothing and can join to nothing, and the
 * ability of a lane to connect to the rest of the curriculum is decided by
 * where it happened to sit in a loop. This call sees all of them at once.
 *
 * It is affordable precisely because it carries NO PROSE. The lane calls send
 * four sentences per concept and cost minutes each; this one sends a name per
 * line and asks for tuples back, which is why the whole curriculum fits in a
 * single call when the concept-writing never could.
 *
 * `known` is every concept already written, and the prompt says plainly that an
 * endpoint naming anything else is dropped. The model cannot invent a concept
 * here — that decision was made in the lane pass and is closed.
 */
export function buildConceptEdgePrompt(
  outline: Outline,
  known: readonly { moduleId: string; name: string }[],
): string {
  const moduleTitle = new Map(outline.modules.map((module) => [module.id, module.title]))
  const laneTitle = new Map(outline.lanes.map((lane) => [lane.id, lane.title]))
  const laneOf = new Map(outline.modules.map((module) => [module.id, module.laneId]))

  // Grouped by lane, then module, because the edges worth finding are the ones
  // BETWEEN lanes, and a flat alphabetical list hides exactly that structure.
  const byLane = new Map<string, Map<string, string[]>>()
  for (const concept of known) {
    const laneId = laneOf.get(concept.moduleId) ?? 'unassigned'
    const modules = byLane.get(laneId) ?? new Map<string, string[]>()
    modules.set(concept.moduleId, [...(modules.get(concept.moduleId) ?? []), concept.name])
    byLane.set(laneId, modules)
  }

  const index = [...byLane].map(([laneId, modules]) => [
    `LANE: ${laneTitle.get(laneId) ?? laneId}`,
    ...[...modules].map(([moduleId, names]) => [
      `  ${moduleTitle.get(moduleId) ?? moduleId}`,
      ...names.map((name) => `    - ${name}`),
    ].join('\n')),
  ].join('\n'))

  return [
    'A learner has approved this outline and its concepts are already written. Your only job now is the',
    'RELATIONSHIPS between them, with the whole curriculum in front of you.',
    '',
    `CURRICULUM: ${outline.title}`,
    `DOMAIN: ${outline.domain}`,
    `${known.length} concept(s) across ${byLane.size} lane(s):`,
    '',
    ...index,
    '',
    'Write NO concepts. The concepts above are final; this call cannot add, rename or remove one.',
    '',
    'conceptEdges: relationships between the concepts listed above, naming both endpoints by the exact',
    '  name given above. An endpoint that is not one of those names is dropped, so copy them literally.',
    '  - The edges worth your attention are the ones BETWEEN LANES. Those concepts were written by',
    '    separate passes that could not see each other, so the joins between them are what is missing',
    '    from the graph and what this call exists to find.',
    '  - kind "hard-prerequisite" when the second genuinely cannot be understood without the first;',
    '    "related" otherwise. A false prerequisite locks a learner out of material they could handle.',
    '  - confidence 0 to 1 is your real belief. Uniform confidences mean the question was not answered.',
    '  - No self-edges, and do not repeat an edge you have already given.',
    '  - Do not manufacture edges to hit a count. A curriculum has the joins it has; a graph padded with',
    '    weak "related" edges is less useful than a sparse one, because every edge claims something.',
    '',
    'Return JSON matching the schema. No prose.',
  ].join('\n')
}
