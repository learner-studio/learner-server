import { expect, test } from 'bun:test'
import { curriculumRollup, curriculumRollups, requiredConceptIds } from './learning-curriculum-rollup.js'

test('nested lessons roll up as unique atomic concepts, not averages of unequal modules',()=>{
  const modules=[{id:'root',parentId:null,conceptIds:['a']},{id:'lesson',parentId:'root',conceptIds:['a','b','c']}]
  expect(requiredConceptIds('root',modules)).toEqual(['a','b','c'])
  expect(curriculumRollup(requiredConceptIds('root',modules),new Map([['a',100],['b',0],['c',0]]))).toMatchObject({estimate:33,required:3,complete:false})
})
test('completion is the summed concept percentages over every required concept; unknown contributes nothing', () => {
  const ids=Array.from({length:10},(_,i)=>`c${i}`)
  expect(curriculumRollup(ids,new Map([['c0',70],['c1',70],['c2',70]]))).toEqual({estimate:21,known:3,unknown:7,required:10,coverage:30,complete:false})
  expect(curriculumRollup(['a','a','b','c'],new Map([['a',100],['b',50],['c',null]]))).toMatchObject({estimate:50,known:2,unknown:1,required:3})
  expect(curriculumRollup(['missing'],new Map())).toMatchObject({estimate:0,known:0,unknown:1})
  expect(curriculumRollup([],new Map())).toMatchObject({estimate:null,complete:false})
})
test('only every required concept exactly 100 completes; rounding cannot manufacture completion', () => {
  expect(curriculumRollup(['a','b'],new Map([['a',100],['b',100]]))).toMatchObject({estimate:100,complete:true})
  expect(curriculumRollup(Array.from({length:300},(_,i)=>`c${i}`),new Map(Array.from({length:300},(_,i)=>[`c${i}`,i?100:95] as const)))).toMatchObject({estimate:99,complete:false})
  expect(curriculumRollup(['a','b'],new Map([['a',100]]))).toMatchObject({estimate:50,unknown:1,complete:false})
  expect(curriculumRollup(['a'],new Map([['a',0]]))).toMatchObject({estimate:0,known:1,unknown:0,complete:false})
})
test('the graph rolls up per module (with descendants), per lane and for the whole curriculum', () => {
  const curriculum={lanes:[{id:'L1'},{id:'L2'},{id:'empty'}],modules:[
    {id:'root',laneId:'L1',parentId:null,conceptIds:['a']},
    {id:'child',laneId:'L1',parentId:'root',conceptIds:['b','c']},
    {id:'other',laneId:'L2',parentId:null,conceptIds:['c','d']},
  ]}
  const assessed=(understandingPercent:number)=>({assessment:{understandingPercent}})
  const concepts=[{id:'a',assessment:assessed(100)},{id:'b',assessment:assessed(40)},{id:'c',assessment:{assessment:null}},{id:'d'}]
  const rollups=curriculumRollups(curriculum,concepts)
  expect(rollups.modules.root).toEqual({estimate:47,known:2,unknown:1,required:3,coverage:2/3*100,complete:false})
  expect(rollups.modules.child).toMatchObject({estimate:20,known:1,required:2})
  expect(rollups.modules.other).toMatchObject({estimate:0,known:0,unknown:2,required:2})
  expect(rollups.lanes.L1).toEqual(rollups.modules.root)
  expect(rollups.lanes.L2).toEqual(rollups.modules.other)
  expect(rollups.lanes.empty).toMatchObject({estimate:null,required:0})
  expect(rollups.curriculum).toMatchObject({estimate:35,known:2,unknown:2,required:4})
})
