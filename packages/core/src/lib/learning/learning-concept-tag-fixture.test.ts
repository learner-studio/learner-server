import {test,expect} from 'bun:test'
import {syntheticTagCases,syntheticTagProvider,liveTagCases} from './learning-concept-tag-fixture.js'
import {scoreTags} from './learning-concept-tag-experiment.js'
const concepts=['A','B','C'].map((title,i)=>({id:title,ref:`c${i+1}`,title,domain:'fixture'}))
test('live synthetic cases have six ordinary messages and never enter mock provider',async()=>{
 const cases=liveTagCases(concepts);expect(cases).toHaveLength(6);expect(cases.some(c=>c.id.includes('invalid'))).toBe(false);await expect(syntheticTagProvider(concepts,cases[0]!,'jev-live')).rejects.toThrow('mock')
})
test('six fixtures exercise TP FP FN no-match assistant-only and malformed response failure',async()=>{
 const cases=syntheticTagCases(concepts);expect(cases.length).toBe(6)
 const f1:number[]=[]
 for(const c of cases){try{const r=await syntheticTagProvider(concepts,c,'jev-mock');f1.push(scoreTags(c.gold,r.ids,true).message_f1)}catch{f1.push(0)}}
 expect(f1).toEqual([1,.5,1,0,0,0])
})
