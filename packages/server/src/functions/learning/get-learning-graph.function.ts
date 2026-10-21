import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { COMPUTER_SCIENCE } from '@learner/core/functions/learning/computer-science-seed.js'
import { addLearnerState, LearningGraphSchema } from '@learner/core/functions/learning/learning-seed.js'
import { LearningGraphWithRollupsSchema, withCurriculumRollups } from '@learner/core/functions/learning/learning-graph-output.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { readLearningGraphDatasets } from '@learner/core/lib/learning/learning-graph-datasets.js'
import { VectorExperiment } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'

export const GetLearningGraphInput = z.object({
  curriculumId: z.string().min(1).optional(),
  datasetTag: z.string().optional(),
})

export const getLearningGraph = defineFunction({
  title: 'Get Learning Graph',
  description: 'Read the current learning curriculum and concept graph.',
  expose: true,
  readonly: true,
  input: GetLearningGraphInput,
  output: LearningGraphWithRollupsSchema,
  func: async ({ learningCurriculumStore, learningConceptAssessment, learningVectorTurns }, input, { session }) => {
    assertLearningLocalMvpEnabled()
    // Only what this learner may see: the shipped library plus their own
    // generated curricula. Selecting from that list rather than fetching the
    // requested id directly is what makes a private curriculum unreachable by
    // guessing its id — an unknown or someone else's id falls back to the
    // library instead of being served.
    const available = await learningCurriculumStore.listGraphsVisibleTo(session.userId)
    const requestedId = input.curriculumId ?? COMPUTER_SCIENCE.curriculum.id
    const selected = available.find((graph) => graph.curriculum.id === requestedId) ?? available[0]
    if (!selected) throw new Error('No learning curricula are available')
    const datasets = await readLearningGraphDatasets(selected.curriculum.id)
    const experiments=await Promise.all(['v3','dev1'].map(tag=>learningVectorTurns.latest(session.userId,tag)))
    const experiment=experiments.find(item=>item && (!input.datasetTag || input.datasetTag==='all' || input.datasetTag===(item.config.datasetTag??'dev1')))
    for(const item of experiments.filter(item=>item!==null)) datasets.push({tag:item.config.datasetTag??'dev1',label:item.label,runId:item.runId,experimentLabel:item.label,pairCount:item.counts?.turns??0,matchCount:item.items.reduce((n,i)=>n+i.matchingChunks,0),conceptIds:selected.concepts.map(c=>c.id),completedAt:item.finishedAt??item.createdAt})
    const graph = addLearnerState(selected, available, datasets)
    const live = (await learningConceptAssessment.list(session.userId)).map(({ sourceIds: _sourceIds, ...summary }) => summary)
    const useExperiment=experiment && (!input.datasetTag || ['all',experiment.config.datasetTag??'dev1'].includes(input.datasetTag))
    return withCurriculumRollups({ ...graph, vectorExperiment:useExperiment?VectorExperiment.parse(experiment):undefined,concepts: graph.concepts.map(concept => {
      const item=useExperiment?experiment.items.find(i=>i.conceptId===concept.id):undefined
      // Explicit datasets preserve experimental snapshots. Default/all is the
      // live learner view, with experiment data only as the initial baseline.
      const current=(!input.datasetTag||input.datasetTag==='all')?live.find(i=>i.conceptId===concept.id):undefined
      const assessment=current??(useExperiment?{conceptId:concept.id,assessment:item?.assessment??null,runId:item?.runId??null,status:item?.status==='pending'?'pending' as const:item?.assessment?'ready' as const:'unknown' as const,assessedAt:item?.assessedAt??null}:undefined)
      return {...concept,assessment}
    }) })
  },
})

/**
 * The local model-facing CLI has no HTTP session. Keep that transport-specific
 * entry point separate from the authenticated dashboard RPC so the CLI can
 * query the same canonical seed without weakening the app's auth boundary.
 */
export const getLearningGraphCli = defineSessionlessFunction({
  title: 'Get Learning Graph (CLI)',
  description: 'Read the current learning curriculum and concept graph from the local CLI.',
  readonly: true,
  input: GetLearningGraphInput,
  output: LearningGraphSchema,
  func: async ({ learningCurriculumStore }, input) => {
    assertLearningLocalMvpEnabled()
    return await learningCurriculumStore.getGraph(input.curriculumId ?? COMPUTER_SCIENCE.curriculum.id)
      ?? COMPUTER_SCIENCE
  },
})
