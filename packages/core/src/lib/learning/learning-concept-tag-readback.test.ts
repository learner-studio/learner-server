import {test,expect} from 'bun:test'
import {tagScoreMatches} from './learning-concept-tag-readback.js'
test('Langfuse v3 subject and configuration are verified, not just a matching score name',()=>{
 const actual={name:'concept_tags_v1.message_f1',configId:'cfg',value:.5,subject:{kind:'observation',id:'span',traceId:'trace'}}
 expect(tagScoreMatches(actual,'trace','span','cfg','message_f1',.5)).toBe(true)
 expect(tagScoreMatches({...actual,subject:{...actual.subject,traceId:'wrong'}},'trace','span','cfg','message_f1',.5)).toBe(false)
 expect(tagScoreMatches(actual,'trace','span','other','message_f1',.5)).toBe(false)
 expect(tagScoreMatches({...actual,name:'concept_tags_v1.exact_match',dataType:'BOOLEAN',value:true},'trace','span','cfg','exact_match',1)).toBe(true)
})
