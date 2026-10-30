import { defineFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { resolveRetrievalLookup } from '@learner/core/lib/learning/learning-playground-retrieval.js'
import { isHeldOut } from '@learner/core/lib/learning/learning-concept-holdout.js'

import { LearningHookContextInput, LearningHookContextOutput } from '@learner/core/lib/learning/learning-hook-context.js'

/** Lookup only: no classifier, responder, consolidation or mastery writes. */
export const getLearningHookContext = defineFunction({
  title:'Get source-backed Learning context for a CLI turn',expose:true,readonly:true,scopes:['admin'],
  input:LearningHookContextInput,output:LearningHookContextOutput,
  func:async ({learningSemanticIndex,learningVectorTurns,learningCurriculumStore},input,{session}) => {
    assertLearningLocalMvpEnabled()
    const started=Date.now()
    const base={datasetTag:'dev1' as const,foundationFirst:input.foundationFirst,policyRevision:'foundation-first-v1' as const,requestId:input.requestId}
    try {
      const graphsPromise=learningCurriculumStore.listGraphs()
      const [hits,projection,graphs]=await Promise.all([
        learningSemanticIndex.search({query:input.message,limit:12,timeoutMs:1800}),
        graphsPromise.then(graphs=>learningVectorTurns.lookupAssessments(session.userId,graphs)),
        graphsPromise,
      ])
      // osmosis-concept-holdout: a held-out concept is never put in front of the agent, on this path as on the live turn.
      const assessments=projection.assessments.filter(item=>!isHeldOut(item.conceptId))
      const result=resolveRetrievalLookup({fixtureId:'cli-hook',foundationFirst:input.foundationFirst,dependencyEdges:graphs.flatMap(graph=>graph.edges)},hits,assessments)
      return {...base,experimentId:projection.experimentId,decision:result.context?'influence' as const:'no_context' as const,
        context:result.context,conceptIds:result.matches.map(match=>match.conceptId),durationMs:Date.now()-started}
    } catch {
      return {...base,experimentId:null,decision:'fail_open' as const,context:'',conceptIds:[],durationMs:Date.now()-started}
    }
  },
})
