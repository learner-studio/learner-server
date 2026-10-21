import { z } from 'zod'

/**
 * The contract between the six steps of `curriculumGenerationWorkflow`.
 *
 * The pipeline deliberately splits retrieval from inference, because they fail
 * differently and are judged differently. Retrieval either found real material
 * or it did not, and that is checkable. Inference invents the prerequisite
 * structure, because no syllabus states the ordering among its own topics and
 * no openly-licensed concept prerequisite graph exists to look it up in. The
 * learner approves the retrieved outline first, so a bad source is caught
 * before any model spends effort shaping it into a tree.
 */

/** A curriculum sized to one course, or to a whole field. The interpreter
 * picks this from the objective, and it decides how many modules the outline
 * step is allowed to propose. */
export const CurriculumScale = z.enum(['course', 'curriculum'])
export type CurriculumScale = z.infer<typeof CurriculumScale>

export const CURRICULUM_SCALE_LIMITS: Readonly<Record<CurriculumScale, { minModules: number; maxModules: number; maxLanes: number }>> = {
  course: { minModules: 4, maxModules: 20, maxLanes: 3 },
  curriculum: { minModules: 12, maxModules: 160, maxLanes: 24 },
}

/** Providers whose terms permit automated reading. Coursera, edX and Khan
 * Academy are absent on purpose: their terms of service forbid scraping, and
 * two of them separately forbid using the content with generative models. */
export const CurriculumProvider = z.enum(['mit-ocw', 'openstax', 'saylor', 'ossu', 'open-textbook-library'])
export type CurriculumProvider = z.infer<typeof CurriculumProvider>

/**
 * One piece of published material the run actually read, carried with its
 * licence so the tree can attribute per node. A module grounded in a CC BY
 * chapter tree and one grounded in a CC BY-NC-SA syllabus owe different
 * credit, so the licence travels with the source rather than with the run.
 */
export const CurriculumSourceRef = z.object({
  sourceId: z.string().min(1),
  provider: CurriculumProvider,
  title: z.string().min(1),
  url: z.string().url(),
  licence: z.string().min(1),
  attribution: z.string().min(1),
  retrievedAt: z.string(),
  contentChars: z.number().int().nonnegative().default(0),
})
export type CurriculumSourceRef = z.infer<typeof CurriculumSourceRef>

/** A candidate course found by search, before its syllabus has been read. */
export const CurriculumCandidate = z.object({
  sourceId: z.string().min(1),
  provider: CurriculumProvider,
  title: z.string().min(1),
  url: z.string().url(),
  licence: z.string().min(1),
  attribution: z.string().min(1),
  /** Where the session-by-session outline lives, when the provider has one
   * separate from the landing page. MIT OpenCourseWare keeps it on a calendar
   * page; OpenStax carries it in the book's collection tree. */
  syllabusUrl: z.string().url().nullable().default(null),
  summary: z.string().default(''),
  /** Why the search step believes this matches the objective. Kept so a
   * rejected outline can be traced back to a bad match rather than a bad
   * model call. */
  matchReason: z.string().default(''),
})
export type CurriculumCandidate = z.infer<typeof CurriculumCandidate>

/** Material fetched for one candidate, ready to feed the outline step. */
export const CurriculumMaterial = z.object({
  source: CurriculumSourceRef,
  markdown: z.string(),
})
export type CurriculumMaterial = z.infer<typeof CurriculumMaterial>

/**
 * The flat outline the learner approves. This is close to a transcription of
 * what the sources actually teach: modules in the order the course teaches
 * them, each with its topics and the material it came from. No prerequisite
 * edges appear here, because none were read from anywhere.
 */
export const CurriculumOutlineModule = z.object({
  /** Slug within the curriculum, namespaced when written to the database. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase kebab-case slug'),
  laneId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  summary: z.string().min(1),
  /** Concept titles this module teaches. Becomes one concept row each. */
  topics: z.array(z.string().min(1)).min(1).max(12),
  /** Which sources this module was drawn from. Empty means the model supplied
   * it without grounding, which the shape report counts separately. */
  sourceIds: z.array(z.string()).default([]),
})
export type CurriculumOutlineModule = z.infer<typeof CurriculumOutlineModule>

/**
 * Which modules must be done before which.
 *
 * Written by the OUTLINE call, not inferred later. It used to be its own call
 * after approval, and the split was justified by size — a prerequisite is one
 * line where a concept is four sentences. But size is the argument for keeping
 * the CONCEPT calls separate; it was never an argument for asking a second
 * model, working from a transcription, to re-derive a structure the outline
 * author already had in mind. Measured on run 4b719d66: the outline reply was
 * 12,951 characters and the dependency reply 8,197, so merging them lands well
 * inside a call that already fits.
 *
 * Moving it here also moves it in FRONT of the human approval gate, which is
 * the real change: the learner now approves the prerequisite spine along with
 * the lessons, rather than approving a flat list and being handed an ordering
 * decided afterwards.
 *
 * Every edge carries a confidence because these are the model's claims, not
 * facts read off a page — no syllabus states its own prerequisites — and the
 * shape report separates high-confidence spine edges from speculative ones.
 */
export const CurriculumModuleDependency = z.object({
  moduleId: z.string().min(1),
  dependsOnModuleId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  /** One sentence saying why the earlier module is needed first. Kept for the
   * shape report and for spot-checking inference quality. */
  rationale: z.string().default(''),
})

export const CurriculumOutlineLane = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  summary: z.string().min(1),
})

export const CurriculumOutline = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  domain: z.string().min(1),
  scale: CurriculumScale,
  lanes: z.array(CurriculumOutlineLane).min(1),
  modules: z.array(CurriculumOutlineModule).min(1),
  /**
   * Defaulted, and the default is load-bearing back-compat rather than
   * optionality. Outlines are stored as JSONB on the run row, so every outline
   * written before 2026-09-11 lacks this key entirely; a required array would
   * make re-approving or rebuilding any of those runs fail to parse — the run
   * would die at a schema boundary for the crime of being old. An empty list
   * reads correctly for them: that outline genuinely states no prerequisites.
   */
  moduleDependencies: z.array(CurriculumModuleDependency).default([]),
})
export type CurriculumOutline = z.infer<typeof CurriculumOutline>

/**
 * An edge between two CONCEPTS, by concept name.
 *
 * It used to name TOPICS, which worked only while a topic and a concept were
 * the same object. They are not: a topic is a lesson and a concept is one idea
 * taught inside it, so a topic-named endpoint now points at three to eight
 * concepts and cannot resolve. Names are unique per module by construction
 * (`conceptGroundingProblems`) and an ambiguous name across modules is dropped
 * at write time rather than guessed.
 */
export const CurriculumConceptEdge = z.object({
  fromConcept: z.string().min(1),
  toConcept: z.string().min(1),
  kind: z.enum(['hard-prerequisite', 'related']),
  confidence: z.number().min(0).max(1),
})

/**
 * What a learner can DO with a concept once they hold it. The seed uses this
 * vocabulary, so a generated concept reads beside a seed concept rather than
 * inventing a parallel taxonomy. The seed also carries a legacy composite
 * value (`explain-predict-diagnose`) on its older rows; generated concepts
 * pick exactly one, because a concept that claims four capabilities is a
 * concept that was never actually sized.
 */
export const CurriculumCapability = z.enum(['explain', 'predict', 'diagnose', 'design', 'compare'])
export type CurriculumCapability = z.infer<typeof CurriculumCapability>

/**
 * ONE IDEA, NOT ONE LESSON.
 *
 * `topic` is the approved outline line this concept is taught under — the
 * LESSON — and `name` is the concept itself. Until 2026-09-10 there was no
 * `name`: a concept WAS its topic, `curriculumConceptId` was keyed by topic
 * text, and the writer looped `module.topics`, so the network graph could only
 * ever be the skill tree at another resolution. Measured on the same database:
 * the seed `computer-science` curriculum carries 664 concepts over 133 modules
 * (4.99 each, 1030 edges) while every generated curriculum landed at 1.4-1.8
 * per module, with concept titles that were transcribed session headings.
 *
 * The two graphs are deliberately different objects: modules plus
 * `moduleDependencies` are the macro skill tree, concepts plus `conceptEdges`
 * are the fine-grained network. A concept name is a NOUN PHRASE in the field's
 * own vocabulary ("Confounder", "Write-ahead log"), never a course or session
 * title.
 */
export const CurriculumConceptDetail = z.object({
  moduleId: z.string().min(1),
  /** The approved outline topic (the lesson) this concept is taught under. */
  topic: z.string().min(1),
  /** The concept itself: one to four words, the field's own term. */
  name: z.string().min(1),
  summary: z.string().min(1),
  explanation: z.string().min(1),
  example: z.string().min(1),
  capability: CurriculumCapability,
})

export const CurriculumGraphProposal = z.object({
  moduleDependencies: z.array(CurriculumModuleDependency).default([]),
  concepts: z.array(CurriculumConceptDetail).default([]),
  conceptEdges: z.array(CurriculumConceptEdge).default([]),
})
export type CurriculumGraphProposal = z.infer<typeof CurriculumGraphProposal>

/**
 * The part of the proposal a single call is actually ASKED for.
 *
 * `CurriculumGraphProposal` above stays the merged shape that is stored and
 * validated, because a half-proposal is never a thing the writer sees. What
 * changed is the request. Asking for prerequisites, every concept's prose and
 * every concept edge in ONE call put a curriculum-scale outline over the CLI's
 * 394-second kill timer (run ee00295d, 2026-09-09; the same size succeeded at
 * 254 s the run before, which is a margin, not a design).
 *
 * The split that survived is by OUTPUT VOLUME, not by subject. Measured on run
 * 4b719d66: the seven lane calls emitted 484,578 characters of prose between
 * them and the largest single lane took 818 s of its 900 s budget, while the
 * outline, the prerequisites and the whole-graph edge pass together emitted
 * 41,189. Anything that answers in names or ids can share a call; anything that
 * answers in paragraphs gets its own. That is why prerequisites now travel with
 * the outline and only the CONCEPTS are still split, one call per LANE — which
 * is also the unit a subject expert would actually write in.
 */
export const CurriculumConceptProposal = z.object({
  concepts: z.array(CurriculumConceptDetail).default([]),
  conceptEdges: z.array(CurriculumConceptEdge).default([]),
})
export type CurriculumConceptProposal = z.infer<typeof CurriculumConceptProposal>

/**
 * The WHOLE-GRAPH edge pass: one call over every concept in the curriculum,
 * asking only for the relationships between them.
 *
 * Why a second pass exists at all. The lane calls above are handed the concept
 * names earlier lanes wrote (`alreadyWritten`), which is what makes a cross-lane
 * edge possible — but only in one direction and only backwards. Lane 1 runs
 * first and has never seen lanes 2-7, so it can propose no cross-lane edge at
 * all; lane 7 sees everything. Measured on the personal-finance rebuild
 * (2026-09-10, run aa35c90b): 115 of 436 edges crossed a lane, and the lanes
 * that ran first were the ones with none. The graph was holistic in proportion
 * to how late a lane happened to be scheduled, which is an artefact of the
 * execution order rather than a fact about the subject.
 *
 * Why it is not simply one call for everything. Asking one call to write the
 * concepts AND their prose AND every edge is what put run ee00295d over the
 * CLI's 394-second kill timer, and that curriculum was a third of this one: the
 * securities lane ALONE took 405 s to write its 54 concepts. This pass carries
 * no prose. Its input is a list of names and its output is a list of tuples, so
 * a curriculum whose concept pass takes half an hour spread over seven calls
 * has an edge pass that is one small call — the whole graph in view, at a
 * fraction of the payload that killed the single-call design.
 */
export const CurriculumConceptEdgeProposal = z.object({
  conceptEdges: z.array(CurriculumConceptEdge).default([]),
})
export type CurriculumConceptEdgeProposal = z.infer<typeof CurriculumConceptEdgeProposal>

/**
 * How many lane concept calls may be in flight at once, drained by a ROLLING
 * POOL: a worker takes the next lane the moment its slot frees, rather than the
 * step waiting for a whole batch to finish.
 *
 * FOUR, raised from one on 2026-09-11 with the measurement that justifies it.
 * Run 4b719d66's seven lanes took 59.3 minutes end to end at a width of one.
 * The same seven, replayed against the pool: 37.5 min at two, 27.2 at three,
 * 22.3 at four, and a floor of 13.6 — the longest single lane — however wide it
 * goes. Four is where the curve flattens; past it the 818-second lane is the
 * whole answer and more slots buy nothing.
 *
 * The cost is real and worth stating. A lane's prompt carries the concepts
 * every lane that has FINISHED wrote, so widening the pool means later lanes
 * see less, and two runs of the same outline need not agree on how much. Width
 * one was the right default while that index was a lane's only knowledge of the
 * rest of the curriculum. It no longer is: since the prerequisite spine moved
 * onto the outline, every lane call carries the whole module structure and its
 * own module's prerequisites REGARDLESS of run order, and the whole-graph edge
 * pass sees all the concepts at once and is where cross-lane joins are
 * guaranteed rather than hoped for. Expect the lane calls' own cross-lane edge
 * count to fall as this rises, and the edge pass's contribution to grow.
 *
 * The process-wide CLI cap (LLM_CLI_MAX_CONCURRENT, 15 here) is the real
 * ceiling — these calls queue behind crawler extractions drawing on the same
 * pool — so a width above about 7 would starve other work before it helped.
 *
 * NOT a throughput knob to maximise. Raise it per run, measure the cross-lane
 * edge split in the edge pass log line, and only then change the default.
 */
export const CURRICULUM_LANE_CONCURRENCY = 4

/** The interpreter's reading of a free-text objective. */
export const CurriculumObjectivePlan = z.object({
  domain: z.string().min(1),
  scale: CurriculumScale,
  /** Search phrases to put to the providers, most specific first. */
  queries: z.array(z.string().min(1)).min(1).max(6),
  /** Providers worth asking, in preference order. */
  providers: z.array(CurriculumProvider).min(1),
  /** Restated objective, used as the curriculum description when no better
   * one comes back from the sources. */
  restated: z.string().min(1),
})
export type CurriculumObjectivePlan = z.infer<typeof CurriculumObjectivePlan>

export const CURRICULUM_RUN_STATUSES = [
  'interpreting', 'sourcing', 'fetching', 'outlining', 'awaiting-approval',
  'inferring', 'writing', 'completed', 'failed', 'rejected',
] as const
export const CurriculumRunStatus = z.enum(CURRICULUM_RUN_STATUSES)
export type CurriculumRunStatus = z.infer<typeof CurriculumRunStatus>

/**
 * Concept and curriculum IDs are namespaced by curriculum so two generated
 * trees never collide in the shared `learning_concepts` table. The seed
 * curriculum's IDs (`ds-question-framing--decision-context`) already read this
 * way, so generated IDs stay legible beside them.
 */
export const curriculumConceptId = (curriculumId: string, moduleId: string, conceptName: string): string =>
  `${curriculumId}.${moduleId}--${slugify(conceptName)}`

/**
 * How many concepts a single approved topic is expected to yield.
 *
 * MIN is the MECHANICAL floor the grounding check enforces, so a thin reply is
 * repaired inside the retry loop rather than written; TARGET and MAX are what
 * the prompt asks for. The floor is 2 rather than the target because a genuinely
 * narrow lesson exists and refusing it would push the model to pad, while 1 is
 * exactly the old topic-is-a-concept behaviour this replaces.
 */
export const CONCEPTS_PER_TOPIC = { min: 2, target: 5, max: 8 } as const

export const slugify = (value: string): string =>
  value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'concept'

/**
 * Where a concept node is drawn, in the seed's own coordinate system.
 *
 * The writer must supply x and y because `learning_concepts` declares both NOT
 * NULL, and a generated tree that placed everything at the origin would render
 * as one pile. These are the exact expressions the Computer Science seed uses,
 * lifted rather than re-derived so a generated tree and the seed lay out on the
 * same grid: lanes march across in columns, modules march down in rows, and
 * concepts within a module fan out slightly so their labels do not overlap.
 *
 * This is a STARTING position, not the final layout. `skill-tree-layout.ts`
 * re-places nodes from prerequisite depth when the tree is rendered — rule 7,
 * "Prerequisites decide the shape". These coordinates are what the graph looks
 * like before that runs, and what a consumer reading the table directly sees.
 */
export const CONCEPT_GRID = { originX: 120, originY: 90, laneStride: 170, columnStride: 70, rowStride: 40, moduleGap: 60, columns: 2 } as const

/**
 * `moduleTop` is where this module's block of concepts STARTS, and the caller
 * accumulates it from the counts it actually wrote.
 *
 * It used to be `moduleIndex * 145`, a fixed band, which was safe only while a
 * module held one or two concepts. At the density this file now asks for
 * (2-8 per lesson, so ten or more per module) a module's own concepts overran
 * the next module's band and the two piled on top of each other — the exact
 * "so their labels do not overlap" property the comment above claims. A stride
 * cannot be a constant when the thing it strides over has variable height.
 */
export const curriculumConceptPosition = (
  laneIndex: number,
  moduleTop: number,
  conceptIndex: number,
): { x: number; y: number } => ({
  x: CONCEPT_GRID.originX + laneIndex * CONCEPT_GRID.laneStride + (conceptIndex % CONCEPT_GRID.columns) * CONCEPT_GRID.columnStride,
  y: moduleTop + Math.floor(conceptIndex / CONCEPT_GRID.columns) * CONCEPT_GRID.rowStride,
})

/** The height one module's block occupies, so the next one can start below it. */
export const curriculumModuleBlockHeight = (conceptCount: number): number =>
  Math.ceil(Math.max(conceptCount, 1) / CONCEPT_GRID.columns) * CONCEPT_GRID.rowStride + CONCEPT_GRID.moduleGap
