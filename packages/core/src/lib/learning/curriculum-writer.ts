import {
  CONCEPTS_PER_TOPIC,
  CURRICULUM_SCALE_LIMITS,
  curriculumConceptId,
  CONCEPT_GRID,
  curriculumConceptPosition,
  curriculumModuleBlockHeight,
  type CurriculumGraphProposal,
  type CurriculumOutline,
  type CurriculumScale,
  type CurriculumSourceRef,
} from './curriculum-generation-types.js'
import { dependencyCycles } from './curriculum-shape.js'

/**
 * Turning an approved outline plus an inferred graph into the exact rows a
 * curriculum is made of.
 *
 * This is deliberately pure. The persistence step around it does nothing but
 * open a transaction and insert what this returns, which means every rule that
 * decides whether a generated curriculum is WELL FORMED can be tested without
 * a database, without a model, and without the network. The model's output is
 * untrusted input here in exactly the way a request body is: it is checked,
 * and a failure names what was wrong rather than writing a broken tree and
 * discovering it when the page will not render.
 */

export type CurriculumWriteRequest = {
  readonly curriculumId: string
  readonly ownerUserId: string
  readonly outline: CurriculumOutline
  readonly proposal: CurriculumGraphProposal
  readonly sources: readonly CurriculumSourceRef[]
}

export type ProvenanceValue = { kind: string; source: string; version: string }

export type CurriculumRows = {
  /**
   * Why proposed edges did not become rows, so the gap between what the model
   * offered and what the graph holds is an answerable question rather than a
   * subtraction. All three are legitimate refusals, not failures.
   */
  readonly conceptEdgeDrops: { readonly ambiguousEndpoint: number; readonly selfAfterResolution: number; readonly duplicate: number }
  readonly curriculum: {
    id: string; title: string; description: string; domain: string
    status: 'draft'; sourceKind: 'generated'; ownerUserId: string; provenance: ProvenanceValue
  }
  readonly lanes: ReadonlyArray<{
    curriculumId: string; id: string; title: string; summary: string
    laneOrder: number; color: string; provenance: ProvenanceValue
  }>
  readonly modules: ReadonlyArray<{
    curriculumId: string; id: string; laneId: string; step: number
    title: string; summary: string; parentId: null
    masteryGoals: readonly string[]; provenance: ProvenanceValue
  }>
  readonly moduleDependencies: ReadonlyArray<{
    curriculumId: string; moduleId: string; dependsOnModuleId: string
    confidence: number; rationale: string
  }>
  readonly concepts: ReadonlyArray<{
    id: string; title: string; summary: string; explanation: string; example: string
    domain: string; capability: string; x: number; y: number
    sourceKind: 'generated'; provenance: ProvenanceValue
  }>
  readonly memberships: ReadonlyArray<{
    curriculumId: string; moduleId: string; conceptId: string; position: number
  }>
  readonly conceptEdges: ReadonlyArray<{
    curriculumId: string; fromConceptId: string; toConceptId: string
    kind: string; confidence: number; provenance: ProvenanceValue
  }>
}

/**
 * Lane colours. The seed's lanes each carry one, the column is NOT NULL, and a
 * model asked to invent hex codes produces both duplicates and unreadable
 * ones. Cycling a fixed palette by lane index is boring and correct.
 */
const LANE_COLOURS = [
  '#4C6EF5', '#12B886', '#F59F00', '#E8590C', '#BE4BDB',
  '#1098AD', '#F06595', '#7048E8', '#37B24D', '#D6336C',
] as const

const laneColour = (index: number): string => LANE_COLOURS[index % LANE_COLOURS.length]!

/**
 * Every reason a proposal may not be written, as plain sentences.
 *
 * Returning a list rather than throwing on the first problem is deliberate: a
 * run that fails is shown to the person who asked for the curriculum, and
 * "three of your modules depend on modules that do not exist" is a far more
 * useful thing to read than the first of the three.
 */
/**
 * Whether a graph proposal is ABOUT the outline it was asked for, checked
 * cheaply enough to run inside the model call's own parse step.
 *
 * Measured 2026-09-09: asked to infer prerequisites for a 54-module outline,
 * the model returned the JSON Schema's own skeleton — one dependency and one
 * concept, every string field the literal `"string"` and every id likewise.
 * That reply is VALID against the schema, so it parsed, the single parse retry
 * never fired, and the failure surfaced two steps later as a wall of writer
 * complaints about a module called "string".
 *
 * A schema cannot express "these ids must come from that outline", so this is
 * where the check belongs: as the parse function's own condition, so a skeleton
 * is a parse failure the retry loop repairs with the reason in the prompt.
 * Returned as messages rather than a boolean because those messages are what
 * the retry shows the model.
 */
/**
 * A topic reduced to what makes two spellings the SAME topic: case, the kind
 * of dash or quote used, run-together whitespace and trailing punctuation all
 * vary between the outline the model was shown and the reply it writes back,
 * and none of them changes which topic is meant.
 *
 * Deliberately narrow. It forgives transcription noise and nothing else: two
 * topics that differ in a word still differ here, so a merged or invented
 * topic is still caught.
 */
export const normalizeTopic = (topic: string): string =>
  topic
    .normalize('NFKD')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim()
    .toLowerCase()

/**
 * The same proposal with every topic it names snapped back to the approved
 * spelling, where the two differ only cosmetically.
 *
 * The learner approved a list of topics, and the tree is written from that
 * list, so a concept's topic has to match one of them EXACTLY or its prose is
 * dropped and the concept is written from its own title. Rewriting a
 * near-miss to the approved literal keeps the model's prose without loosening
 * the rule that follows it: what is compared afterwards is still exact
 * equality against the approved list.
 */
export function alignProposalTopics(
  outline: Pick<CurriculumOutline, 'modules'>,
  proposal: CurriculumGraphProposal,
): CurriculumGraphProposal {
  const approvedByModule = new Map(
    outline.modules.map((module) => [module.id, new Map(module.topics.map((topic) => [normalizeTopic(topic), topic]))]),
  )
  // Edges name CONCEPTS, and the model spells a name in an edge slightly
  // differently from the way it spelled it in the concept ("write-ahead log"
  // vs "Write-ahead log"). Snap an edge endpoint onto a proposed concept name
  // when the normalized form is unambiguous — the same near-miss repair the
  // topics get, one level down. Endpoints naming a concept from an earlier
  // lane are not in this proposal and pass through untouched, to be resolved
  // against the whole curriculum at write time.
  const proposedNames = new Map<string, string[]>()
  for (const concept of proposal.concepts) {
    const key = normalizeTopic(concept.name)
    proposedNames.set(key, [...(proposedNames.get(key) ?? []), concept.name])
  }
  const alignEdgeConcept = (name: string): string => {
    const matches = proposedNames.get(normalizeTopic(name))
    return matches && new Set(matches).size === 1 ? matches[0]! : name
  }

  return {
    ...proposal,
    concepts: proposal.concepts.map((concept) => {
      const approved = approvedByModule.get(concept.moduleId)?.get(normalizeTopic(concept.topic))
      return approved && approved !== concept.topic ? { ...concept, topic: approved } : concept
    }),
    conceptEdges: proposal.conceptEdges.map((edge) => ({
      ...edge,
      fromConcept: alignEdgeConcept(edge.fromConcept),
      toConcept: alignEdgeConcept(edge.toConcept),
    })),
  }
}

type GroundedModule = Pick<CurriculumOutline['modules'][number], 'id' | 'title' | 'topics'>

/**
 * The prerequisite half of the grounding check, over the WHOLE outline.
 *
 * Split from the concept half on 2026-09-09 so each can be handed to the call
 * that produced it: prerequisites are asked for once over every module, while
 * concepts are asked for one lane at a time. A checker that insisted on seeing
 * the whole curriculum would reject every lane call for the modules it was
 * deliberately not asked to write.
 */
export function dependencyGroundingProblems(
  modules: readonly GroundedModule[],
  moduleDependencies: CurriculumGraphProposal['moduleDependencies'],
): string[] {
  const moduleIds = new Set(modules.map((module) => module.id))
  const problems: string[] = []

  const unknown = moduleDependencies.find(
    (dependency) => !moduleIds.has(dependency.moduleId) || !moduleIds.has(dependency.dependsOnModuleId),
  )
  if (unknown) {
    problems.push(
      `Dependency ${unknown.moduleId} -> ${unknown.dependsOnModuleId} names a module id that is not in the outline. ` +
        `Use only the module ids listed in the outline above.`,
    )
  }

  // "No circles" was a prompt rule with nothing enforcing it, which was
  // survivable only while the spine was re-rolled on every rebuild. Since
  // 2026-09-11 the learner APPROVES the spine and nothing regenerates it, so a
  // cycle approved once is a cycle forever. It does not crash anything —
  // `prerequisiteDepths` carries a trail and refuses to recurse — it silently
  // assigns one of the modules in the loop an arbitrary depth, which draws a
  // tree that says a module comes after itself. Better caught here, where the
  // retry can still be told.
  const dependsOn = new Map<string, string[]>()
  for (const dependency of moduleDependencies) {
    dependsOn.set(dependency.moduleId, [...(dependsOn.get(dependency.moduleId) ?? []), dependency.dependsOnModuleId])
  }
  const settled = new Set<string>()
  const findCycle = (id: string, trail: readonly string[]): string[] | undefined => {
    const looped = trail.indexOf(id)
    if (looped !== -1) return [...trail.slice(looped), id]
    if (settled.has(id)) return undefined
    for (const next of dependsOn.get(id) ?? []) {
      const cycle = findCycle(next, [...trail, id])
      if (cycle) return cycle
    }
    settled.add(id)
    return undefined
  }
  for (const id of dependsOn.keys()) {
    const cycle = findCycle(id, [])
    if (cycle) {
      problems.push(
        `The prerequisites form a circle: ${cycle.join(' depends on ')}. ` +
          `A learner could never start any module in that loop. Decide which one genuinely comes first and drop the edge that closes the circle.`,
      )
      break
    }
  }

  return problems
}

/**
 * The WHOLE-GRAPH edge pass, checked against the concepts that actually exist.
 *
 * `known` is every concept the lane passes wrote, keyed by the name the model
 * will use to refer to it. Two things are worth failing here rather than
 * silently dropping downstream.
 *
 * An endpoint naming no written concept is a hallucinated node. The writer
 * would discard that edge quietly, so a reply that invented half its endpoints
 * would look like a thin answer rather than a wrong one — and the retry loop,
 * which is the only place the model can still be told, would never run.
 *
 * A reply with no CROSS-LANE edge at all is the specific failure this whole
 * pass exists to catch. The lane calls already produced within-lane edges; this
 * call was given the entire curriculum precisely so it could find the joins
 * between lanes that no single lane call could see. Coming back with none of
 * them, on a curriculum with more than one lane, means the call did the lane
 * pass's job again. That is a soft signal rather than a hard one on a
 * single-lane curriculum, which genuinely has no cross-lane edge to find, so
 * the check only applies when there are at least two lanes holding concepts.
 */
export function conceptEdgeGroundingProblems(
  known: readonly { name: string; laneId: string }[],
  conceptEdges: CurriculumGraphProposal['conceptEdges'],
): string[] {
  const laneByName = new Map(known.map((concept) => [concept.name.trim().toLowerCase(), concept.laneId]))
  const problems: string[] = []

  const unknown = [...new Set(conceptEdges
    .flatMap((edge) => [edge.fromConcept, edge.toConcept])
    .filter((name) => !laneByName.has(name.trim().toLowerCase())))]
  if (unknown.length > 0) {
    problems.push(
      `Edge endpoint(s) ${unknown.slice(0, 5).map((name) => `"${name}"`).join(', ')} name no concept in the curriculum. ` +
        `Every endpoint must be copied exactly from the concept list above; this call cannot introduce a concept.`,
    )
  }

  const selfEdge = conceptEdges.find((edge) => edge.fromConcept.trim().toLowerCase() === edge.toConcept.trim().toLowerCase())
  if (selfEdge) {
    problems.push(`"${selfEdge.fromConcept}" is joined to itself. A concept cannot be its own prerequisite or relation.`)
  }

  const lanes = new Set(known.map((concept) => concept.laneId))
  if (lanes.size > 1) {
    const crossLane = conceptEdges.filter((edge) => {
      const from = laneByName.get(edge.fromConcept.trim().toLowerCase())
      const to = laneByName.get(edge.toConcept.trim().toLowerCase())
      return from !== undefined && to !== undefined && from !== to
    })
    if (crossLane.length === 0) {
      problems.push(
        `Not one of the ${conceptEdges.length} edge(s) joins two different lanes, across ${lanes.size} lanes of concepts. ` +
          `The within-lane edges are already written; this call has the whole curriculum in view so that it can find the ` +
          `relationships BETWEEN lanes, which is the only thing it adds.`,
      )
    }
  }

  return problems
}

/**
 * The concept half, over exactly the modules the call was ASKED to write.
 *
 * `modules` is the lane's modules for a per-lane call and the whole outline for
 * a single-call proposal, and everything below is scoped to that set — which is
 * what makes the same function usable at both scales.
 */
export function conceptGroundingProblems(
  modules: readonly GroundedModule[],
  concepts: CurriculumGraphProposal['concepts'],
): string[] {
  const moduleIds = new Set(modules.map((module) => module.id))
  const problems: string[] = []

  const unknownConcept = concepts.find((concept) => !moduleIds.has(concept.moduleId))
  if (unknownConcept) {
    problems.push(
      `A concept was proposed for module "${unknownConcept.moduleId}", which is not one of the modules you were asked to write. ` +
        `Use only the module ids listed above.`,
    )
  }

  // The approved topics are the contract: the learner said yes to a list of
  // LESSONS, and every one of them owes concepts. What changed on 2026-09-10 is
  // the cardinality — a topic used to owe exactly one concept, which made the
  // concept graph a copy of the skill tree (measured: 1.4-1.8 concepts per
  // module across every generated curriculum, against 4.99 in the seed). It now
  // owes at least CONCEPTS_PER_TOPIC.min, and the complaint stays HERE, inside
  // the retry loop, because two steps downstream in the writer the model can no
  // longer be asked to fix it (run 9b005d78 died that way).
  //
  // Reported for the first few modules only — the message is a prompt, and a
  // 54-module outline would otherwise bury the instruction in a list.
  const mismatched: string[] = []
  for (const module of modules) {
    const approved = new Set(module.topics)
    const written = concepts.filter((concept) => concept.moduleId === module.id)
    const invented = [...new Set(written.filter((concept) => !approved.has(concept.topic)).map((concept) => concept.topic))]
    const thin = module.topics
      .map((topic) => ({ topic, count: written.filter((concept) => concept.topic === topic).length }))
      .filter((entry) => entry.count < CONCEPTS_PER_TOPIC.min)

    // A name repeated inside one module collapses to a single concept id at
    // write time, so the duplicates would vanish silently rather than fail.
    const seen = new Map<string, number>()
    for (const concept of written) {
      const key = concept.name.trim().toLowerCase()
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([name]) => name)

    // The exact regression this rule exists for: a concept named after the
    // lesson or the module is the skill tree returned a second time.
    const restated = [...new Set(written
      .filter((concept) => normalizeTopic(concept.name) === normalizeTopic(concept.topic)
        || normalizeTopic(concept.name) === normalizeTopic(module.title))
      .map((concept) => concept.name))]

    if (invented.length === 0 && thin.length === 0 && duplicated.length === 0 && restated.length === 0) continue
    const parts = [
      invented.length > 0
        ? `it was given topic(s) ${invented.map((topic) => `"${topic}"`).join(', ')} that the learner never approved`
        : '',
      thin.length > 0
        ? `${thin.slice(0, 4).map((entry) => `"${entry.topic}" has ${entry.count}`).join(', ')} ` +
          `(each topic needs at least ${CONCEPTS_PER_TOPIC.min}, about ${CONCEPTS_PER_TOPIC.target})`
        : '',
      duplicated.length > 0 ? `the name(s) ${duplicated.map((name) => `"${name}"`).join(', ')} were used twice` : '',
      restated.length > 0
        ? `${restated.map((name) => `"${name}"`).join(', ')} restate the lesson or the module instead of naming a concept inside it`
        : '',
    ].filter(Boolean)
    mismatched.push(`Module "${module.id}": ${parts.join('; ')}.`)
  }
  if (mismatched.length > 0) {
    problems.push(
      ...mismatched.slice(0, 5),
      ...(mismatched.length > 5 ? [`${mismatched.length - 5} further module(s) have the same problem.`] : []),
      `Copy each topic string EXACTLY as the outline spells it, and under each one write ` +
        `${CONCEPTS_PER_TOPIC.min}-${CONCEPTS_PER_TOPIC.max} concepts whose names are the field's own terms — ` +
        `not the lesson's title, not the module's title, and never the same name twice in one module.`,
    )
  }
  return problems
}

/**
 * The outline step's OWN grounding check — the one step of the run that had
 * none.
 *
 * Every other model call in this run is checked inside its retry loop, and the
 * outline was the outlier, so a thin transcription passed straight through to a
 * human approval gate. Measured 2026-09-10: run aa35c90b produced 22 modules
 * carrying 38 topics between them (1.7 each) and run c92f6e9a 14 modules
 * carrying 32 (2.3), against a prompt that says in its own words "A module may
 * have two topics or twelve". Topics are LESSONS and each lesson is now several
 * concepts, so an outline that under-transcribes is a multiplier on everything
 * downstream — no concept-side fix can recover a lesson the outline never
 * listed.
 *
 * Two rules only, and neither of them evens the modules out (prompt rule 2
 * forbids that, and it is right — real courses are uneven):
 *
 *  - A module with one topic that RESTATES its own title is the transcribed
 *    calendar row prompt rule 3 already forbids. A module with one genuinely
 *    distinct topic is left alone; narrow units exist.
 *  - The outline as a WHOLE averaging below two topics per module is a
 *    transcription that collapsed, not a course that happens to be narrow.
 *    Judged in aggregate precisely so an individual thin module stays legal.
 */
export function outlineGroundingProblems(
  outline: Pick<CurriculumOutline, 'modules' | 'moduleDependencies'>,
): string[] {
  // The outline now carries the prerequisite spine, so the outline's own retry
  // loop is where a bad edge has to be caught. It used to be checked in the
  // separate dependency call; leaving it unchecked here would mean a dangling
  // module id reached the learner as something to approve.
  const problems: string[] = [...dependencyGroundingProblems(outline.modules, outline.moduleDependencies)]

  const empty = outline.modules.filter((module) => module.topics.length === 0).map((module) => module.id)
  if (empty.length > 0) {
    problems.push(
      `Module(s) ${empty.slice(0, 5).map((id) => `"${id}"`).join(', ')} list no topics at all. ` +
        `Every module must list what it actually covers, in the source's own terms.`,
    )
  }

  const calendarRows = outline.modules.filter((module) =>
    module.topics.length === 1 && normalizeTopic(module.topics[0]!) === normalizeTopic(module.title))
  if (calendarRows.length > 0) {
    problems.push(
      `Module(s) ${calendarRows.slice(0, 5).map((module) => `"${module.id}"`).join(', ')} have a single topic that just ` +
        `repeats the module's own title. That is a transcribed calendar row, not a module: either list the subjects ` +
        `the module actually teaches, or fold it into the module whose subject it belongs to.`,
    )
  }

  const topics = outline.modules.reduce((total, module) => total + module.topics.length, 0)
  const perModule = topics / Math.max(outline.modules.length, 1)
  if (outline.modules.length > 0 && perModule < 2) {
    problems.push(
      `This outline has ${topics} topic(s) across ${outline.modules.length} module(s), ${perModule.toFixed(1)} each. ` +
        `A topic is a LESSON, and a module that teaches only one lesson is almost always a session heading that was ` +
        `copied as a module. Go back to the sources and list what each module actually covers — two topics or twelve, ` +
        `uneven is correct, but one apiece across a whole curriculum means the units were not read.`,
    )
  }

  return problems
}

/** Both halves, for a proposal covering the whole outline at once. */
export function proposalGroundingProblems(
  outline: Pick<CurriculumOutline, 'modules'>,
  proposal: CurriculumGraphProposal,
): string[] {
  return [
    ...dependencyGroundingProblems(outline.modules, proposal.moduleDependencies),
    ...conceptGroundingProblems(outline.modules, proposal.concepts),
  ]
}

export function validateCurriculumWrite(request: CurriculumWriteRequest): string[] {
  const { outline, proposal } = request
  const problems: string[] = []

  const limits = CURRICULUM_SCALE_LIMITS[outline.scale as CurriculumScale]
  if (outline.modules.length < limits.minModules || outline.modules.length > limits.maxModules) {
    problems.push(
      `A ${outline.scale} must have between ${limits.minModules} and ${limits.maxModules} modules, and this outline has ${outline.modules.length}.`,
    )
  }
  if (outline.lanes.length > limits.maxLanes) {
    problems.push(`A ${outline.scale} may have at most ${limits.maxLanes} lanes, and this outline has ${outline.lanes.length}.`)
  }

  const laneIds = new Set(outline.lanes.map((lane) => lane.id))
  const moduleIds = new Set<string>()
  for (const module of outline.modules) {
    if (moduleIds.has(module.id)) problems.push(`Two modules share the id "${module.id}".`)
    moduleIds.add(module.id)
    if (!laneIds.has(module.laneId)) {
      problems.push(`Module "${module.id}" is in lane "${module.laneId}", which the outline does not define.`)
    }
  }

  for (const dependency of proposal.moduleDependencies) {
    if (!moduleIds.has(dependency.moduleId)) {
      problems.push(`A prerequisite was proposed for module "${dependency.moduleId}", which is not in the outline.`)
    }
    if (!moduleIds.has(dependency.dependsOnModuleId)) {
      problems.push(`Module "${dependency.moduleId}" was given the prerequisite "${dependency.dependsOnModuleId}", which is not in the outline.`)
    }
    if (dependency.moduleId === dependency.dependsOnModuleId) {
      problems.push(`Module "${dependency.moduleId}" was made its own prerequisite.`)
    }
  }

  // A cycle is fatal rather than cosmetic. The skill tree assigns each module a
  // row from its prerequisite depth, and a cycle has no terminating depth, so
  // a cyclic curriculum is one that cannot be drawn at all. Nothing stops a
  // model claiming A needs B and B needs A, so this is checked every time.
  for (const cycle of cyclesIn(outline, proposal)) {
    problems.push(`These modules depend on each other in a circle, which has no starting point: ${cycle.join(' → ')}.`)
  }

  const topicsByModule = new Map(outline.modules.map((module) => [module.id, new Set(module.topics)]))
  for (const concept of proposal.concepts) {
    const topics = topicsByModule.get(concept.moduleId)
    if (!topics) {
      problems.push(`A concept was written for module "${concept.moduleId}", which is not in the outline.`)
      continue
    }
    if (!topics.has(concept.topic)) {
      problems.push(`Module "${concept.moduleId}" was given the concept "${concept.topic}", which is not one of its approved topics.`)
    }
  }

  // Every approved topic must come back as a concept. A topic silently dropped
  // between approval and writing is the failure the learner is least able to
  // notice: they approved an outline and received a smaller tree.
  for (const module of outline.modules) {
    const written = new Set(proposal.concepts.filter((c) => c.moduleId === module.id).map((c) => c.topic))
    const missing = module.topics.filter((topic) => !written.has(topic))
    if (missing.length > 0) {
      problems.push(`Module "${module.id}" approved ${module.topics.length} topics but ${missing.length} were never written: ${missing.join(', ')}.`)
    }
    // The same floor grounding enforces, restated at the last gate. The two
    // must agree: a proposal the retry loop would have rejected must not become
    // writable simply because it arrived here by another path (a whole-outline
    // proposal, or a replay of a run recorded before the floor existed).
    const thin = module.topics.filter((topic) =>
      proposal.concepts.filter((concept) => concept.moduleId === module.id && concept.topic === topic).length
        < CONCEPTS_PER_TOPIC.min)
    if (thin.length > 0) {
      problems.push(
        `Module "${module.id}" has ${thin.length} lesson(s) with fewer than ${CONCEPTS_PER_TOPIC.min} concepts: ` +
          `${thin.slice(0, 4).map((topic) => `"${topic}"`).join(', ')}.`,
      )
    }
  }

  return problems
}

/** Module dependency cycles, reusing the shape library's detector so the
 * rejection rule and the reported metric can never disagree. */
function cyclesIn(outline: CurriculumOutline, proposal: CurriculumGraphProposal): string[][] {
  const dependsOn = new Map<string, string[]>()
  for (const dependency of proposal.moduleDependencies) {
    const existing = dependsOn.get(dependency.moduleId) ?? []
    existing.push(dependency.dependsOnModuleId)
    dependsOn.set(dependency.moduleId, existing)
  }
  return dependencyCycles(outline.modules.map((module) => ({
    id: module.id,
    dependsOnModuleIds: dependsOn.get(module.id) ?? [],
    // The module's real concept count. This read `module.topics.length` while a
    // topic and a concept were the same object; they are not, and a module of
    // three lessons now holds a dozen concepts.
    conceptCount: proposal.concepts.filter((concept) => concept.moduleId === module.id).length,
  })))
}

/**
 * The rows for an approved curriculum. Callers must run
 * `validateCurriculumWrite` first; this assumes a valid request and would
 * otherwise write a tree that cannot be drawn.
 */
export function buildCurriculumRows(request: CurriculumWriteRequest): CurriculumRows {
  const { curriculumId, ownerUserId, outline, proposal, sources } = request
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]))
  const generated: ProvenanceValue = { kind: 'model-generated', source: 'curriculum-generation', version: today() }

  /**
   * A node's provenance names the material it came from, so attribution and
   * the grounded-share metric read from the same place. A module citing
   * sources is `external-material` with the first source named; one the model
   * supplied unaided is `model-generated`. The distinction is the whole point
   * of the comparison against the hand-authored seed.
   */
  const moduleProvenance = (sourceIds: readonly string[]): ProvenanceValue => {
    const cited = sourceIds.map((id) => sourceById.get(id)).find((source) => source !== undefined)
    return cited
      ? { kind: 'external-material', source: `${cited.provider}:${cited.sourceId}`, version: cited.retrievedAt.slice(0, 10) }
      : generated
  }

  const laneIndex = new Map(outline.lanes.map((lane, index) => [lane.id, index]))

  const concepts: Array<CurriculumRows['concepts'][number]> = []
  const memberships: Array<CurriculumRows['memberships'][number]> = []
  const conceptIdsByName = new Map<string, string[]>()

  // ITERATE THE PROPOSAL, NOT `module.topics`.
  //
  // This loop used to walk the approved topic list and write exactly one row
  // per topic, reading the model's prose off a `topic -> concept` map. That made
  // the topic list structurally the concept list: a lane could return thirty
  // concepts and twenty-four of them would be dropped without a word. Topics
  // still set the ORDER (they are the sequence the learner approved) and still
  // gate what may be written (grounding rejects an unapproved topic upstream),
  // but the rows now come from the concepts themselves.
  // Each lane is a column and its modules stack DOWN it, so the next module
  // starts below whatever the previous one actually needed. A per-lane cursor
  // rather than a per-curriculum one, because lanes are laid out side by side.
  // Explicit <string, number>: CONCEPT_GRID is `as const`, so inference would
  // pin the value type to the literal 90 and refuse the running cursor below.
  const laneTop = new Map<string, number>(outline.lanes.map((lane) => [lane.id, CONCEPT_GRID.originY]))

  outline.modules.forEach((module) => {
    const mine = proposal.concepts.filter((concept) => concept.moduleId === module.id)
    const byTopic = new Map(module.topics.map((topic) => [topic, [] as typeof mine]))
    for (const concept of mine) byTopic.get(concept.topic)?.push(concept)

    let conceptIndex = 0
    const moduleTop = laneTop.get(module.laneId) ?? CONCEPT_GRID.originY
    for (const topic of module.topics) {
      // A topic the model wrote nothing for still owes the learner a node —
      // they approved it. Grounding fails such a proposal, so this is the
      // last-resort shape for a reply that got past it (one concept named
      // after the lesson), not the normal path.
      const written = byTopic.get(topic) ?? []
      const details = written.length > 0
        ? written
        : [{ moduleId: module.id, topic, name: topic, summary: topic, explanation: topic, example: topic, capability: 'explain' as const }]

      for (const detail of details) {
        // Namespaced by curriculum AND module, so two generated curricula can
        // never collide in the shared learning_concepts table, and a concept
        // reads back to the tree it belongs to.
        const id = curriculumConceptId(curriculumId, module.id, detail.name)
        if (concepts.some((existing) => existing.id === id)) continue
        conceptIdsByName.set(detail.name, [...(conceptIdsByName.get(detail.name) ?? []), id])
        const { x, y } = curriculumConceptPosition(laneIndex.get(module.laneId) ?? 0, moduleTop, conceptIndex)
        concepts.push({
          id,
          title: detail.name,
          summary: detail.summary,
          explanation: detail.explanation,
          example: detail.example,
          domain: outline.domain,
          capability: detail.capability,
          x, y,
          sourceKind: 'generated',
          provenance: moduleProvenance(module.sourceIds),
        })
        conceptIndex += 1
        memberships.push({ curriculumId, moduleId: module.id, conceptId: id, position: conceptIndex })
      }
    }
    laneTop.set(module.laneId, moduleTop + curriculumModuleBlockHeight(conceptIndex))
  })

  // Concept edges are proposed between concept NAMES, which are unique within a
  // module by grounding but not across the curriculum, so an edge naming a name
  // used in two modules is ambiguous. Rather than guess, an edge is kept only
  // when both of its endpoints resolve to exactly one concept.
  const resolveConcept = (name: string): string | undefined => {
    const matches = conceptIdsByName.get(name)
    return matches?.length === 1 ? matches[0] : undefined
  }

  const conceptEdges: Array<CurriculumRows['conceptEdges'][number]> = []
  const seenEdges = new Set<string>()
  // Counted, not merely skipped. Three different things used to collapse into
  // one silent `continue`, and the only visible trace was an arithmetic gap
  // between the edges the generator logged as proposed and the edges the graph
  // ended up with — run 4b719d66 proposed 1059 and stored 1052, with nothing
  // anywhere saying which seven or why. A drop is a decision; it gets a number.
  const conceptEdgeDrops = { ambiguousEndpoint: 0, selfAfterResolution: 0, duplicate: 0 }
  for (const edge of proposal.conceptEdges) {
    const from = resolveConcept(edge.fromConcept)
    const to = resolveConcept(edge.toConcept)
    if (!from || !to) { conceptEdgeDrops.ambiguousEndpoint += 1; continue }
    // Distinct NAMES can resolve to one concept, so a self-edge can appear here
    // even though the grounding check upstream rejects a literal `A -> A`.
    if (from === to) { conceptEdgeDrops.selfAfterResolution += 1; continue }
    const key = `${from}>${to}`
    // Ignores `kind` on purpose: one pair of concepts gets one link, and two
    // calls each labelling the same pair differently is not two relationships.
    if (seenEdges.has(key)) { conceptEdgeDrops.duplicate += 1; continue }
    seenEdges.add(key)
    conceptEdges.push({ curriculumId, fromConceptId: from, toConceptId: to, kind: edge.kind, confidence: edge.confidence, provenance: generated })
  }

  return {
    curriculum: {
      id: curriculumId,
      title: outline.title,
      description: outline.description,
      domain: outline.domain,
      status: 'draft',
      sourceKind: 'generated',
      ownerUserId,
      provenance: generated,
    },
    lanes: outline.lanes.map((lane, index) => ({
      curriculumId, id: lane.id, title: lane.title, summary: lane.summary,
      laneOrder: index + 1, color: laneColour(index), provenance: generated,
    })),
    modules: outline.modules.map((module, index) => ({
      curriculumId, id: module.id, laneId: module.laneId, step: index + 1,
      title: module.title, summary: module.summary, parentId: null,
      masteryGoals: [
        `Explain ${module.title} as a connected mental model.`,
        `Predict how changing one part of ${module.title} affects the rest.`,
      ],
      provenance: moduleProvenance(module.sourceIds),
    })),
    moduleDependencies: dedupeDependencies(request),
    concepts,
    memberships,
    conceptEdges,
    conceptEdgeDrops,
  }
}

/** One row per ordered pair, keeping the highest-confidence claim when a model
 * proposes the same prerequisite twice with different reasons. */
function dedupeDependencies(request: CurriculumWriteRequest): Array<CurriculumRows['moduleDependencies'][number]> {
  const best = new Map<string, { curriculumId: string; moduleId: string; dependsOnModuleId: string; confidence: number; rationale: string }>()
  for (const dependency of request.proposal.moduleDependencies) {
    if (dependency.moduleId === dependency.dependsOnModuleId) continue
    const key = `${dependency.moduleId}>${dependency.dependsOnModuleId}`
    const existing = best.get(key)
    if (existing && existing.confidence >= dependency.confidence) continue
    best.set(key, {
      curriculumId: request.curriculumId,
      moduleId: dependency.moduleId,
      dependsOnModuleId: dependency.dependsOnModuleId,
      confidence: dependency.confidence,
      rationale: dependency.rationale,
    })
  }
  return [...best.values()]
}

const today = (): string => new Date().toISOString().slice(0, 10)
