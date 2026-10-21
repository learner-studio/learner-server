import { defineFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { ConceptCoverageInput,ConceptCoverage } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'

export const getLearningConceptCoverage=defineFunction({title:'Inspect what each incremental grading pass of one concept read and covered',expose:true,readonly:true,scopes:['admin'],input:ConceptCoverageInput,output:ConceptCoverage,
  func:async({learningVectorTurns},data,{session})=>{
    assertLearningLocalMvpEnabled()
    const {conceptId,limit,recentConcepts}=ConceptCoverageInput.parse(data)
    const conceptIds=conceptId?[conceptId]:await learningVectorTurns.recentIncrementalConcepts(session.userId,recentConcepts)
    return {concepts:await Promise.all(conceptIds.map(async id=>({conceptId:id,passes:await learningVectorTurns.coverageHistory(session.userId,id,limit)})))}
  },
})
