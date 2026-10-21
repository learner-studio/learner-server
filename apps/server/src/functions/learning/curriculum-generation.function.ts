import { defineSessionlessFunction, type WiredServices } from '../../runtime/define.js'
import { z } from 'zod'

import {
  CURRICULUM_LANE_CONCURRENCY,
  CurriculumCandidate,
  CurriculumConceptEdgeProposal,
  CurriculumConceptProposal,
  CurriculumGraphProposal,
  CurriculumObjectivePlan,
  CurriculumOutline,
  CurriculumSourceRef,
  slugify,
  type CurriculumMaterial,
} from '@learner/core/lib/learning/curriculum-generation-types.js'
import {
  createCurriculumJsonReader,
  createCurriculumPageReader,
} from '@learner/core/lib/learning/curriculum-page-reader.js'
import {
  CONCEPT_EDGE_SCHEMA,
  CONCEPT_SCHEMA,
  OBJECTIVE_PLAN_SCHEMA,
  OUTLINE_SCHEMA,
  buildConceptEdgePrompt,
  buildLaneConceptPrompt,
  buildObjectivePlanPrompt,
  buildOutlinePrompt,
} from '@learner/core/lib/learning/curriculum-prompts.js'
import {
  RELEVANCE_SCHEMA,
  applyRelevanceVerdicts,
  buildRelevancePrompt,
  describeRelevanceRefusal,
  CurriculumRelevanceVerdicts,
} from '@learner/core/lib/learning/curriculum-relevance.js'
import {
  fetchCurriculumMaterial,
  searchCurriculumSources,
} from '@learner/core/lib/learning/curriculum-sources.js'
import { measureStoredCurriculumShape } from '@learner/core/lib/learning/curriculum-shape-query.js'
import { mapWithConcurrency } from '@learner/core/lib/map-with-concurrency.js'
import {
  alignProposalTopics,
  buildCurriculumRows,
  conceptEdgeGroundingProblems,
  conceptGroundingProblems,
  outlineGroundingProblems,
  validateCurriculumWrite,
} from '@learner/core/lib/learning/curriculum-writer.js'

/**
 * The steps of a curriculum generation run: interpret the learner's sentence,
 * find published course material, transcribe it into an outline they approve,
 * then infer the prerequisite structure and write the tree.
 *
 * The run is split across TWO workflows because the approval gate is a human
 * boundary that may take days. A single workflow suspended on human input
 * would hold a durable run open for that whole time; two workflows make the
 * waiting state a plain row with `status = 'awaiting-approval'`, which is also
 * what the frontend polls.
 *
 * Every step writes the run's status BEFORE it does its work, so a run that
 * dies mid-step is legible as "died while outlining" rather than as silence.
 */

type GenerationServices = Pick<
  WiredServices,
  'logger' | 'llmService' | 'learningCurriculumGenerationStore' | 'markdownReader' | 'kysely'
>

/** How much of one source's material reaches the outline prompt. */
const OUTLINE_CHARS_PER_SOURCE = 60_000
/** How many candidates are read before outlining. More sources means a wider
 * outline, but every one of them is a browser render. */
const MATERIAL_LIMIT = 3

/**
 * Source readers. The previous host routed page renders through its crawler
 * stack (Cloudflare or the local Firecrawl tier, by a global mode switch);
 * Learner has no crawler, so pages are read through the injected markdown
 * reader (local Firecrawl) and the reader runs in 'local' mode.
 */
const readers = async (markdownReader: WiredServices['markdownReader']) => ({
  fetchJson: createCurriculumJsonReader(),
  fetchMarkdown: createCurriculumPageReader({
    mode: 'local',
    renderCloudflareMarkdown: (url) => markdownReader.markdown(url),
    renderLocalMarkdown: (url) => markdownReader.markdown(url),
  }),
})

/** A model call that must answer in one exact shape, validated by the contract
 * that the writer will later hold it to. */
const structured = async <T>(
  llmService: WiredServices['llmService'],
  label: string,
  prompt: string,
  outputSchema: Record<string, unknown>,
  schema: z.ZodType<T>,
  /** Conditions the schema cannot express — "these ids come from that
   * outline". Returning messages makes a bad reply a PARSE failure, so the
   * retry carries the reason instead of the caller discovering it later. */
  alsoRequire?: (value: T) => string[],
  /** The call policy. Defaults to the extractor's, which is right for the
   * steps that READ source material. The two graph calls pass the authoring
   * policy instead — see `curriculumAuthoringCallOptions`. */
  callOptions: Record<string, unknown> = llmService.extractorCallOptions(),
): Promise<T> => {
  const parsed = await llmService.callLLMWithStructuredOutput({
    label,
    prompt,
    outputSchema,
    parseFn: (value: unknown) => {
      const shaped = schema.parse(typeof value === 'string' ? JSON.parse(value) : value)
      const problems = alsoRequire?.(shaped) ?? []
      if (problems.length > 0) throw new Error(problems.join(' '))
      return shaped
    },
    callOptions,
    maxParseRetries: 2,
    // Without this the two retries above re-send the SAME prompt and the model
    // is never told what was wrong — the `alsoRequire` comment above claims the
    // retry "carries the reason", and until this line it did not. The flag
    // defaults to false (`lib/llm/llm-service.ts:804`); seven other structured
    // call sites in the repo set it, and curriculum generation was the outlier.
    includeParseFailureFeedback: true,
  })
  return parsed as T
}

/**
 * Run one step's body, and record on the run itself if it throws.
 *
 * Without this a failed run keeps the status of the phase it died in. Run
 * 9755d3a3 (2026-09-09) was refused by the relevance gate — correctly — and sat
 * at `fetching` afterwards, indistinguishable from a run still reading pages.
 * The approval screen polls that status, so a dead run would spin forever and
 * the reason it died, which is the useful part, would live only in a log line.
 *
 * The status write is best-effort: if the database is the thing that failed,
 * the original error is still what the caller must see, so a failure to record
 * must not replace it.
 */
const recordingFailure = async <T>(
  store: WiredServices['learningCurriculumGenerationStore'],
  runId: string,
  step: () => Promise<T>,
): Promise<T> => {
  try {
    return await step()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await store.updateRun(runId, { status: 'failed', error: message }).catch(() => undefined)
    throw error
  }
}

export const StartCurriculumProposalInput = z.object({
  runId: z.string().min(1),
  objective: z.string().min(1),
  /** The activity feed drops runs whose owner it cannot resolve. */
  userId: z.string().min(1),
})

/**
 * The build workflow takes the owner too, exactly as the proposal workflow
 * does. Not decoration: the input schema rejects any key it does not declare,
 * so a starter passing `userId` — which every starter should, or the activity
 * feed silently drops the run — failed the whole workflow at validation with
 * "Property userId does not match additional properties schema". The run sat
 * at `inferring` and looked stuck. Declaring the field is what makes the two
 * workflows startable the same way.
 */
export const StartCurriculumBuildInput = z.object({
  runId: z.string().min(1),
  /** The activity feed drops runs whose owner it cannot resolve. */
  userId: z.string().min(1),
})

// ---------------------------------------------------------------- step 1

export const InterpretCurriculumObjectiveInput = z.object({
  runId: z.string().min(1),
  objective: z.string().min(1),
})

export const interpretCurriculumObjectiveStep = defineSessionlessFunction({
  title: 'Interpret a learning objective into a search plan',
  input: InterpretCurriculumObjectiveInput,
  output: CurriculumObjectivePlan,
  func: async ({ logger, llmService, learningCurriculumGenerationStore }: GenerationServices, { runId, objective }) =>
    recordingFailure(learningCurriculumGenerationStore, runId, async () => {
      await learningCurriculumGenerationStore.updateRun(runId, { status: 'interpreting' })
      const plan = await structured(
        llmService,
        `Curriculum objective plan ${runId}`,
        buildObjectivePlanPrompt(objective),
        OBJECTIVE_PLAN_SCHEMA,
        CurriculumObjectivePlan,
      )
      await learningCurriculumGenerationStore.updateRun(runId, {
        domain: plan.domain,
        scale: plan.scale,
        status: 'sourcing',
      })
      // The queries are logged because they are the one input that decides what
      // the run can possibly be grounded in, and a run sourced from the wrong
      // courses is unattributable without them.
      logger.info(
        `[curriculum] ${runId}: ${plan.scale} in ${plan.domain}, asking ${plan.providers.join(', ')} for ${plan.queries.map((query) => `"${query}"`).join(', ')}`,
      )
      return plan
    }),
})

// ---------------------------------------------------------------- step 2

export const SourceCurriculumCandidatesInput = z.object({
  runId: z.string().min(1),
  plan: CurriculumObjectivePlan,
})

export const SourceCurriculumCandidatesOutput = z.object({
  candidates: z.array(CurriculumCandidate),
})

export const sourceCurriculumCandidatesStep = defineSessionlessFunction({
  title: 'Search open course providers for published material',
  input: SourceCurriculumCandidatesInput,
  output: SourceCurriculumCandidatesOutput,
  func: async ({ logger, learningCurriculumGenerationStore, markdownReader }: GenerationServices, { runId, plan }) =>
    recordingFailure(learningCurriculumGenerationStore, runId, async () => {
      const candidates = await searchCurriculumSources(plan, await readers(markdownReader))
      if (candidates.length === 0) {
        // Better to say "nothing published matches this" than to hand the outline
        // step no material and let it invent a course from the objective alone.
        throw new Error(`No published course material found for this objective (asked ${plan.providers.join(', ')})`)
      }
      await learningCurriculumGenerationStore.updateRun(runId, { status: 'fetching' })
      logger.info(`[curriculum] ${runId}: ${candidates.length} candidate(s), best ${candidates[0]!.sourceId}`)
      return { candidates }
    }),
})

// ---------------------------------------------------------------- step 3

export const OutlineCurriculumInput = z.object({
  runId: z.string().min(1),
  objective: z.string().min(1),
  plan: CurriculumObjectivePlan,
  candidates: z.array(CurriculumCandidate),
})

export const OutlineCurriculumOutput = z.object({
  outline: CurriculumOutline,
  sources: z.array(CurriculumSourceRef),
})

export const outlineCurriculumStep = defineSessionlessFunction({
  title: 'Transcribe published material into an outline for approval',
  input: OutlineCurriculumInput,
  output: OutlineCurriculumOutput,
  func: async ({ logger, llmService, learningCurriculumGenerationStore, markdownReader }: GenerationServices, { runId, objective, plan, candidates }) =>
    recordingFailure(learningCurriculumGenerationStore, runId, async () => {
      // Judge relevance from titles and summaries BEFORE anything is rendered.
      // The first live run proved the model can tell an unrelated course from a
      // relevant one and had no way to say so: `CurriculumOutline` requires at
      // least one module, so a run grounded in three unrelated courses produced
      // a Dynamics curriculum for an algorithms objective rather than refusing.
      const { verdicts } = await structured(
        llmService,
        `Curriculum relevance ${runId}`,
        buildRelevancePrompt(objective, plan, candidates),
        RELEVANCE_SCHEMA,
        CurriculumRelevanceVerdicts,
      )
      const { kept, dropped } = applyRelevanceVerdicts(candidates, verdicts)
      for (const { candidate, reason } of dropped) {
        logger.warn(`[curriculum] ${runId}: dropped ${candidate.sourceId} — ${reason}`)
      }
      if (kept.length === 0) {
        throw new Error(describeRelevanceRefusal(objective, dropped))
      }

      const deps = await readers(markdownReader)
      const materials: CurriculumMaterial[] = []
      for (const candidate of kept) {
        if (materials.length >= MATERIAL_LIMIT) break
        try {
          materials.push(await fetchCurriculumMaterial(candidate, deps))
        } catch (error) {
          // One unreadable provider page is normal. The run fails only when NO
          // candidate could be read at all, which is the check below.
          logger.warn(`[curriculum] ${runId}: ${candidate.sourceId} unreadable — ${String(error)}`)
        }
      }
      if (materials.length === 0) {
        throw new Error(`None of the ${kept.length} relevant source(s) could be read`)
      }

      const sources = materials.map((material) => material.source)
      await learningCurriculumGenerationStore.recordSources(runId, sources)
      await learningCurriculumGenerationStore.updateRun(runId, { status: 'outlining' })

      const outline = await structured(
        llmService,
        `Curriculum outline ${runId}`,
        buildOutlinePrompt(objective, plan, materials, OUTLINE_CHARS_PER_SOURCE),
        OUTLINE_SCHEMA,
        CurriculumOutline,
        // The outline is the step a human APPROVES, so a thin one is not merely
        // a bad reply — it is a bad reply the learner is asked to say yes to.
        (candidate) => outlineGroundingProblems(candidate),
      )
      await learningCurriculumGenerationStore.updateRun(runId, {
        outline,
        status: 'awaiting-approval',
      })
      logger.info(`[curriculum] ${runId}: outline of ${outline.modules.length} module(s) awaiting approval`)
      return { outline, sources }
    }),
})

// ---------------------------------------------------------------- step 4

export const CurriculumRunRef = z.object({ runId: z.string().min(1) })

export const InferCurriculumGraphOutput = z.object({ proposal: CurriculumGraphProposal })

export const inferCurriculumGraphStep = defineSessionlessFunction({
  title: 'Write the concepts beneath an approved outline and the network between them',
  input: CurriculumRunRef,
  output: InferCurriculumGraphOutput,
  func: async ({ logger, llmService, learningCurriculumGenerationStore }: GenerationServices, { runId }) =>
    recordingFailure(learningCurriculumGenerationStore, runId, async () => {
      const run = await learningCurriculumGenerationStore.getRunById(runId)
      if (!run?.outline) throw new Error(`Run ${runId} has no approved outline`)
      await learningCurriculumGenerationStore.updateRun(runId, { status: 'inferring' })
      const outline = run.outline

      /**
       * ONE CALL PER LANE — not one call for the whole graph, and no longer a
       * separate call for the prerequisites either: those now arrive on the
       * approved outline, written by the same reply that invented the lanes.
       *
       * Every reply is parsed against the OUTLINE, not only against the
       * schema: a reply that is schema-valid but describes nothing (the
       * model's own skeleton, ids all the literal "string") must fail here,
       * where the retry can repair it with the reason, rather than two steps
       * later in the writer.
       *
       * The split is a TIMEOUT fix as much as a quality one. Run ee00295d
       * (2026-09-09) asked one call for 49 dependencies plus 74 concepts with
       * four sentences of prose each plus every edge between them, and the
       * codex CLI killed it at 394 s; the same size had succeeded at 254 s the
       * run before, which is a margin rather than a design. A step whose
       * success depends on finishing inside a fixed kill timer fails on the
       * next slightly larger curriculum, so the call is split rather than the
       * timer raised.
       *
       * Lanes run one after another. They are independent, but a failure
       * replays the whole step either way (the checkpoint is the step, not the
       * lane), and serial calls keep this step inside the process-wide CLI
       * concurrency cap that every crawler extraction is also drawing on.
       *
       * Every lane call is handed the WHOLE outline, prerequisite spine
       * included. The split is forced by how much prose has to come back, not
       * by how much the caller is willing to say — so each call knows the full
       * structure even though it only writes a seventh of it.
       */
      const lanes = outline.lanes.filter((lane) => outline.modules.some((module) => module.laneId === lane.id))
      const concepts: CurriculumGraphProposal['concepts'] = []
      const conceptEdges: CurriculumGraphProposal['conceptEdges'] = []
      const seenEdge = new Set<string>()
      /** Two calls can each propose the edge that joins them, and the writer would then draw it twice. */
      const keepNewEdges = (proposed: CurriculumGraphProposal['conceptEdges']): number => {
        let kept = 0
        for (const edge of proposed) {
          const key = `${edge.fromConcept}\u0000${edge.toConcept}\u0000${edge.kind}`
          if (seenEdge.has(key)) continue
          seenEdge.add(key)
          conceptEdges.push(edge)
          kept += 1
        }
        return kept
      }

      // A ROLLING POOL, not fixed batches.
      //
      // Slices waste the difference between the lanes inside one slice: a batch
      // takes as long as its slowest member, so a 234 s lane sharing a slice
      // with an 818 s one leaves its slot idle for nearly ten minutes. Measured
      // on run 4b719d66's seven lanes, at a width of three that is 37.5 min for
      // slices against 27.2 min for a pool — and the pool at width THREE beats
      // slices at width FOUR (28.0 min), which is the part that matters. Lower
      // width means more lanes still see `alreadyWritten`, so the pool buys the
      // minutes without spending as much of the cross-lane context.
      //
      // What a pool costs is that `alreadyWritten` becomes timing-dependent
      // rather than order-dependent: a lane is handed whatever had FINISHED
      // when it started, which two runs need not agree on. That is an honest
      // description of what concurrency already did — at width four the first
      // four lanes see nothing regardless — and it is affordable now for a
      // reason it was not before: every lane call carries the prerequisite
      // spine, which does not depend on run order at all, and the whole-graph
      // edge pass is the guarantee that the joins get found.
      //
      // The MERGE stays in lane order. Results land in a slot array indexed by
      // lane and are folded in afterwards, so the graph a given outline
      // produces does not depend on which lane happened to finish first.
      type LaneReply = {
        readonly lane: (typeof lanes)[number]
        readonly laneModules: typeof outline.modules
        readonly reply: { concepts: CurriculumGraphProposal['concepts']; conceptEdges: CurriculumGraphProposal['conceptEdges'] }
      }
      const laneReplies = new Array<LaneReply | undefined>(lanes.length)

      const runLane = async (lane: (typeof lanes)[number], index: number): Promise<LaneReply> => {
        const laneModules = outline.modules.filter((module) => module.laneId === lane.id)
        // Read at the moment this lane STARTS, from the slots already filled.
        // Walking the slot array keeps the names in lane order even though
        // which lanes are present depends on timing.
        const alreadyWritten = laneReplies
          .flatMap((done) => done?.reply.concepts ?? [])
          .map(({ moduleId, name }) => ({ moduleId, name }))
        const reply = await structured(
          llmService,
          `Curriculum concepts ${runId} [${lane.id}]`,
          buildLaneConceptPrompt(outline, lane.id, alreadyWritten),
          CONCEPT_SCHEMA,
          // Snapped to the approved spellings BEFORE the grounding check, so a
          // dash or a stray capital in a copied topic is repaired rather than
          // sent back to the model as a complaint it would answer identically.
          // Alignment reads the WHOLE outline because a concept edge may point
          // at a topic in another lane, which is how the lanes join up.
          CurriculumConceptProposal.transform((candidate) => {
            const aligned = alignProposalTopics(outline, { moduleDependencies: [], ...candidate })
            return { concepts: aligned.concepts, conceptEdges: aligned.conceptEdges }
          }),
          (candidate) => conceptGroundingProblems(laneModules, candidate.concepts),
          llmService.curriculumAuthoringCallOptions(),
        )
        laneReplies[index] = { lane, laneModules, reply }
        logger.info(
          `[curriculum] ${runId}: lane ${lane.id} gave ${reply.concepts.length} concept(s) for ` +
            `${laneModules.reduce((total, module) => total + module.topics.length, 0)} topic(s) across ` +
            `${laneModules.length} module(s), seeing ${alreadyWritten.length} concept(s) from lanes already done`,
        )
        return laneReplies[index]!
      }

      // A lane that throws rejects the whole step, which is what should happen:
      // the checkpoint is the step, so a partial set of lanes is never written.
      // mapWithConcurrency hands results back in LANE order whatever order
      // they finished in, which is what keeps the merge below deterministic.
      const ordered = await mapWithConcurrency(lanes, CURRICULUM_LANE_CONCURRENCY, runLane)

      for (const done of ordered) {
        concepts.push(...done.reply.concepts)
        keepNewEdges(done.reply.conceptEdges)
      }

      // The whole graph in one call, names only, edges only.
      //
      // Every lane call above saw only the lanes that had FINISHED when it
      // started, so the joins it could propose were decided by scheduling — the
      // first lanes out of the pool can join to nothing, and widening the pool
      // makes that true of more of them. This pass sees all the concepts at
      // once and is therefore the only place a cross-lane edge is guaranteed
      // rather than hoped for. It is affordable because it carries no prose:
      // a list of names in, a list of tuples out. Its edges are merged into the
      // lane pass's rather than replacing them, because a within-lane edge
      // proposed by the expert that wrote that lane is the better one.
      const laneOfModule = new Map(outline.modules.map((module) => [module.id, module.laneId]))
      const known = concepts.map((concept) => ({
        name: concept.name,
        laneId: laneOfModule.get(concept.moduleId) ?? '',
      }))
      const laneById = new Map(known.map((concept) => [concept.name.trim().toLowerCase(), concept.laneId]))
      const countCrossLane = (edges: CurriculumGraphProposal['conceptEdges']): number => edges.filter((edge) => {
        const from = laneById.get(edge.fromConcept.trim().toLowerCase())
        const to = laneById.get(edge.toConcept.trim().toLowerCase())
        return from !== undefined && to !== undefined && from !== to
      }).length
      const beforeEdgePass = conceptEdges.length
      // Measured BEFORE the call, because the whole justification for spending a
      // seventh-plus-one model call is the cross-lane edges the serial lane pass
      // structurally cannot propose: a lane sees only the lanes written before
      // it, so lane 1 can join to nothing. Logging only the total afterwards
      // leaves that contribution unattributable — run 4b719d66 finished with 481
      // cross-lane edges and no way to say how many the edge pass was responsible
      // for. Two numbers, one subtraction.
      const crossLaneBefore = countCrossLane(conceptEdges)
      const edgeReply = await structured(
        llmService,
        `Curriculum concept edges ${runId}`,
        buildConceptEdgePrompt(outline, concepts.map(({ moduleId, name }) => ({ moduleId, name }))),
        CONCEPT_EDGE_SCHEMA,
        CurriculumConceptEdgeProposal,
        (candidate) => conceptEdgeGroundingProblems(known, candidate.conceptEdges),
        llmService.curriculumAuthoringCallOptions(),
      )
      const addedByEdgePass = keepNewEdges(edgeReply.conceptEdges)
      const crossLane = countCrossLane(conceptEdges)
      logger.info(
        `[curriculum] ${runId}: edge pass proposed ${edgeReply.conceptEdges.length} edge(s) over ${concepts.length} concept(s), ` +
          `${addedByEdgePass} of them new (${beforeEdgePass} from the lane calls); ` +
          `${crossLane} of ${conceptEdges.length} edge(s) now cross a lane, ` +
          `up from ${crossLaneBefore} of ${beforeEdgePass} — the edge pass contributed ${crossLane - crossLaneBefore}`,
      )

      const proposal: CurriculumGraphProposal = {
        // Approved by the learner with the outline, not inferred here.
        moduleDependencies: outline.moduleDependencies,
        concepts,
        conceptEdges,
      }
      await learningCurriculumGenerationStore.updateRun(runId, { graphProposal: proposal })
      logger.info(
        `[curriculum] ${runId}: ${proposal.moduleDependencies.length} prerequisite(s), ${proposal.concepts.length} concept(s), ` +
          `${proposal.conceptEdges.length} concept edge(s) across ${lanes.length} lane call(s) plus one whole-graph edge call`,
      )
      return { proposal }
    }),
})

// ---------------------------------------------------------------- step 5

export const WriteCurriculumOutput = z.object({
  curriculumId: z.string(),
  modules: z.number(),
  concepts: z.number(),
})

export const writeCurriculumStep = defineSessionlessFunction({
  title: 'Write the approved curriculum as a skill tree',
  input: CurriculumRunRef,
  output: WriteCurriculumOutput,
  func: async ({ logger, kysely, learningCurriculumGenerationStore }: GenerationServices, { runId }) =>
    recordingFailure(learningCurriculumGenerationStore, runId, async () => {
      const run = await learningCurriculumGenerationStore.getRunById(runId)
      if (!run?.outline || !run.graphProposal) throw new Error(`Run ${runId} has no outline and proposal to write`)
      await learningCurriculumGenerationStore.updateRun(runId, { status: 'writing' })

      const curriculumId = `gen-${slugify(run.outline.title)}-${runId.slice(0, 8)}`
      const request = {
        curriculumId,
        ownerUserId: run.ownerUserId,
        outline: run.outline,
        proposal: run.graphProposal,
        sources: await learningCurriculumGenerationStore.listSources(runId),
      }

      const problems = validateCurriculumWrite(request)
      if (problems.length > 0) {
        // Every problem, not the first: this text is what the learner reads when
        // a run fails, and one problem at a time makes it a guessing game.
        throw new Error(`The proposal cannot be drawn:\n- ${problems.join('\n- ')}`)
      }

      const rows = buildCurriculumRows(request)
      await learningCurriculumGenerationStore.writeCurriculum(rows)
      const shape = await measureStoredCurriculumShape(kysely, curriculumId)
      await learningCurriculumGenerationStore.updateRun(runId, {
        curriculumId,
        shape,
        status: 'completed',
        error: null,
      })
      const drops = rows.conceptEdgeDrops
      const dropped = drops.ambiguousEndpoint + drops.selfAfterResolution + drops.duplicate
      logger.info(
        `[curriculum] ${runId}: wrote ${curriculumId} — ${rows.modules.length} modules, ${rows.concepts.length} concepts, ` +
          `${rows.conceptEdges.length} concept edge(s) from ${request.proposal.conceptEdges.length} proposed` +
          (dropped === 0
            ? ''
            : ` (${dropped} dropped: ${drops.ambiguousEndpoint} naming a concept used in two modules, ` +
              `${drops.selfAfterResolution} joining a concept to itself once names resolved, ${drops.duplicate} already drawn)`),
      )
      return { curriculumId, modules: rows.modules.length, concepts: rows.concepts.length }
    }),
})
