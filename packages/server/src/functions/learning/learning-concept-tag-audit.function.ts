import {defineSessionlessFunction} from '../../runtime/define.js'
import {ConceptTagItem,ConceptTagAny} from './learning-concept-tag-rpc.function.js'
import {admitTagAudit} from '@learner/core/lib/learning/learning-concept-tag-audit-admission.js'
/** Separate durable, retryable telemetry work; the paid queue slot waits only for admission. */
export const enqueueLearningConceptTagAuditStep=defineSessionlessFunction({input:ConceptTagItem,output:ConceptTagAny,func:async({queueService,queueCancellationService,locks},data)=>locks.withLock('concept-tag-audit-enqueue',data.jobKey,()=>admitTagAudit(data,{find:(queue,key)=>queueCancellationService.findByKey(queue,key),add:(queue,job,options)=>queueService.add(queue,job,options)}))})
