import { expect,test } from 'bun:test'
import { taskTeachingContext,TASK_TEACHING_DEFAULT } from './learning-teaching-default.js'
const base={ids:['css'],catalog:[{id:'css',title:'CSS box model'}],assessments:[],suppressed:new Set<string>(),gaps:[],edges:[],foundationFirst:true}
test('unassessed concepts remain eligible without vector retrieval',()=>{
  const packet=taskTeachingContext(base)
  expect(packet.conceptIds).toEqual(['css'])
  expect(packet.context).toContain('"understandingPercent":null')
  expect(packet.context).toContain('demonstrated skillfulness')
  expect(packet.context).toContain('assume a complete beginner')
})
test('catalog gaps do not prohibit task-connected teaching',()=>{
  expect(taskTeachingContext({...base,ids:[]}).context).toContain('actual task')
  expect(TASK_TEACHING_DEFAULT).toContain('must not prevent teaching')
})
test('v1.4 expands foundations while preserving a task anchor even if legacy toggle is false',()=>{
  const packet=taskTeachingContext({...base,ids:['c','b','a','d'],catalog:['a','b','c','d'].map(id=>({id,title:id})),foundationFirst:false,edges:[{from:'a',to:'b',kind:'hard-prerequisite'},{from:'b',to:'c',kind:'hard-prerequisite'}]})
  expect(packet.conceptIds).toEqual(['a','c','b','d'])
  expect(packet.context).toContain('LEARNING TEACHING POLICY v1.4')
  expect(packet.context).toContain('why the mechanism works')
  expect(packet.context).toContain('With no demonstration')
  expect(packet.context).toContain('at most one')
})
test('foundation guidance stays relevant and does not manufacture weakness or require checks on every turn',()=>{
  for(const text of ['weakest evidenced prerequisite','Unknown is not zero mastery','unobserved, not a demonstrated gap','Do not detour','because X, we do Y','silence is not failure','Skip checks on approvals']) expect(TASK_TEACHING_DEFAULT).toContain(text)
})
test('demonstrations suppress repeats while partial evidence narrows the target',()=>{
  expect(taskTeachingContext({...base,suppressed:new Set(['css'])}).conceptIds).toEqual([])
  const packet=taskTeachingContext({...base,suppressed:new Set(['css']),gaps:[{conceptId:'css',remainingGap:'Margin versus padding'}]})
  expect(packet.conceptIds).toEqual(['css'])
  expect(packet.context).toContain('Margin versus padding')
})
test('escaped gap content cannot exceed the structured guidance ceiling',()=>{
  const packet=taskTeachingContext({...base,gaps:[{conceptId:'css',remainingGap:'\u0000'.repeat(500)}]})
  expect(packet.context.length).toBeLessThanOrEqual(4000)
  expect(packet.conceptIds).toEqual([])
})
