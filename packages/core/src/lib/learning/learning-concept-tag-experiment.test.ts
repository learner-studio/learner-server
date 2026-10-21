import {test,expect} from 'bun:test'
import {scoreTags,summarizeTags,tagHash} from './learning-concept-tag-experiment.js'
test('historical DB date values retain identity after JSONB serialization',()=>{const source={startedAt:new Date('2026-09-05T18:00:00Z')};expect(tagHash(source)).toBe(tagHash(JSON.parse(JSON.stringify(source))))})
test('failed empty is not a correct no-match; positive failures incur false negatives',()=>{
 expect(scoreTags([],[],false)).toMatchObject({message_f1:0,exact_match:0,valid_result:0})
 expect(scoreTags(['a'],[],false)).toMatchObject({tp:0,fp:0,fn:1,message_f1:0})
 expect(scoreTags([],[],true)).toMatchObject({message_f1:1,exact_match:1,no_match_spurious:0})
 expect(scoreTags(['a','b'],['a','c'],true)).toMatchObject({tp:1,fp:1,fn:1,message_f1:.5})
 const summary=summarizeTags([{gold:['a'],predicted:['a'],valid:true,latencyMs:10},{gold:[],predicted:['a'],valid:true,latencyMs:20},{gold:['b'],predicted:[],valid:false,latencyMs:30}])
 expect(summary).toMatchObject({meanMessageF1:1/3,microPrecision:.5,microRecall:.5,microF1:.5,failureRate:1/3,p50:20,p95:30})
})
