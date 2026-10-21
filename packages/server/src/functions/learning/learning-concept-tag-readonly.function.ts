import {defineFunction} from '../../runtime/define.js'
import {ConceptTagRun,ConceptTagAny} from './learning-concept-tag-rpc.function.js'
import {tagRun} from '@learner/core/services/learning-concept-tag-store.js'
import {tagHash} from '@learner/core/lib/learning/learning-concept-tag-experiment.js'
import {verifyHistorical} from '@learner/core/lib/learning/learning-concept-tag-historical-telemetry.js'
/** No paid execution, export replay or historical summary rewrite is reachable here. */
export const verifyLearningHistoricalTagReadOnly=defineFunction({title:'Read-only exact historical native audit',expose:true,readonly:true,scopes:['admin'],input:ConceptTagRun,output:ConceptTagAny,func:async({},data,{session})=>{
 const row=await tagRun(data.runId);if(row.user_id!==session.userId)throw new Error('Not experiment owner');if(!row.manifest.historical)throw new Error('Historical run required')
 const before=tagHash(row),start=performance.now(),summary=await verifyHistorical(row,{readOnly:true})
 return {runId:data.runId,wallMs:performance.now()-start,counts:summary.counts,unchanged:before===tagHash(await tagRun(data.runId))}
}})
