import {test} from 'node:test'
import assert from 'node:assert/strict'
import {historicalDecisionRequest,validateHistoricalSource,agreementScores} from './learning-concept-tag-historical.js'
test('historical source requires exact complete membership, raw tags and title-only frozen catalog',()=>{
 const catalog=[{id:'id',ref:'c1',title:'State'}], cases=[{case_id:'case',input_snapshot:{current:{role:'user',authorship:'human',text:'state'},context:[],ontologyCandidateIds:['id']}}],results=[{case_id:'case',status:'completed',extraction:{matches:[{conceptId:'id'}]}}],audit={caseIds:['case'],raw:JSON.stringify({results:[{caseId:'case',classification:{matches:[{conceptId:'c1'}]}}]}),prompt:'CASES:\n'+JSON.stringify([{caseId:'case',precedingConversation:[],currentLearnerMessage:'state'}])+'\n\nSEED V1 OPERATOR-PAIR CONTEXT:'}
 assert.doesNotThrow(()=>validateHistoricalSource(catalog,cases,results,audit,1))
 assert.throws(()=>validateHistoricalSource(catalog,cases,[],audit,1),/membership/)
 assert.throws(()=>validateHistoricalSource(catalog,cases,[{...results[0],status:'failed'}],audit,1),/baseline/)
 assert.throws(()=>validateHistoricalSource(catalog,cases,results,{...audit,raw:'{"results":[]}'},1),/raw/)
 const request=historicalDecisionRequest(catalog,'state',[])
 assert.deepEqual(request.state.concepts,catalog)
 assert.ok(!JSON.stringify(request).includes('gold'))
 assert.match(request.questions.c1!.instructions,/State/)
 assert.ok(request.questions.c1!.instructions.length<150,'shared rubric must not be repeated once per concept')
 assert.match(request.state.taggingRules,/concrete implementation detail/)
 assert.ok(request.questions.c1!.instructions.length<180,'shared rubric must not be repeated 470 times')
 assert.equal(agreementScores(['id'],['id'],true).set_f1_agreement,1)
 assert.equal(agreementScores([],[],false).valid_result,0)
 assert.ok(!('message_f1' in agreementScores([],[],true)))
})
