import {test,expect} from 'bun:test'
import {weakestPrerequisites} from './learning-prerequisite-selection.js'
import {taskTeachingContext} from './learning-teaching-default.js'
import {LearningConceptAssessmentSchema} from './learning-concept-assessment-schemas.js'
const edge=(from:string,to:string)=>({from,to,kind:'hard-prerequisite'})
const base={targets:['task'],catalogIds:['root','mid','peer','task','unrelated'],edges:[edge('root','mid'),edge('mid','task'),edge('peer','task')],scores:new Map([['root',10],['mid',10],['peer',10],['unrelated',0]]),suppressed:new Set<string>()}
test('traverses unmatched ancestors, keeps tied upstream branches and excludes unrelated weakness',()=>{
  const result=weakestPrerequisites(base)
  expect(result.foundations.map(f=>f.conceptId)).toEqual(['peer','root'])
  expect(result.minimum).toBe(10)
  expect(result.foundations.every(f=>f.supports.includes('task'))).toBe(true)
})
test('lowest percentage precedes hierarchy tie breaker',()=>{
  expect(weakestPrerequisites({...base,scores:new Map([['root',50],['mid',5],['peer',20]])}).foundations.map(f=>f.conceptId)).toEqual(['mid'])
})
test('unknown is not zero; all known mastered foundations do not force remediation',()=>{
  const result=weakestPrerequisites({...base,scores:new Map([['mid',30]])})
  expect(result.foundations.map(f=>f.conceptId)).toEqual(['mid'])
  const unknown=weakestPrerequisites({...base,scores:new Map()})
  expect(unknown.mode).toBe('unknown')
  expect(unknown.foundations.every(f=>f.understandingPercent===null)).toBe(true)
  expect(weakestPrerequisites({...base,scores:new Map([['root',100],['mid',100],['peer',100]])}).foundations).toEqual([])
})
test('ignores soft edges and invalid IDs; cycles terminate and deduplicate',()=>{
  const result=weakestPrerequisites({...base,targets:['task','task'],edges:[...base.edges,edge('mid','root'),edge('missing','task'),{from:'unrelated',to:'task',kind:'related'}]})
  expect(result.foundations.map(f=>f.conceptId)).toEqual(['mid','peer','root'])
  expect(result.foundations.every(f=>f.supports.length===1)).toBe(true)
})
test('recent suppression prevents a stale low score from reopening a taught foundation',()=>{
  expect(weakestPrerequisites({...base,suppressed:new Set(['root','peer'])}).foundations.map(f=>f.conceptId)).toEqual(['mid'])
})
test('packet includes actual prerequisite support and task anchor without exceeding current wire limits',()=>{
  const packet=taskTeachingContext({ids:['task'],catalog:base.catalogIds.map(id=>({id,title:id})),edges:base.edges,assessments:[],suppressed:new Set(),gaps:[],foundationFirst:true})
  expect(packet.conceptIds).toContain('root')
  expect(packet.conceptIds).toContain('peer')
  expect(packet.conceptIds).toContain('task')
  expect(packet.context).toContain('"supports":["task"]')
  expect(packet.context).toContain('weakest lesson prerequisite in prompt')
  expect(packet.context.length).toBeLessThanOrEqual(4000)
})
test('large ties are explicitly accounted for, not silently omitted',()=>{
  const roots=Array.from({length:12},(_,i)=>`root${i}`)
  const packet=taskTeachingContext({ids:['task'],catalog:[...roots,'task'].map(id=>({id,title:id})),edges:roots.map(id=>edge(id,'task')),assessments:[],suppressed:new Set(),gaps:[],foundationFirst:true})
  expect(packet.conceptIds).toContain('task')
  expect(packet.conceptIds.length).toBeLessThanOrEqual(5)
  const summary=JSON.parse(packet.context.split('\nPrerequisite selection: ')[1]!)
  expect(summary.tiedFoundations).toBe(12)
  expect(summary.omittedFoundations).toBe(12-(packet.conceptIds.length-1))
})
test('packet ranks real-shaped assessments but ignores stale or insufficient percentages',()=>{
  const assessment=(conceptId:string,percent:number,status='ready',confidence='medium')=>LearningConceptAssessmentSchema.parse({conceptId,status,assessedAt:'2026-09-07T00:00:00Z',runId:null,assessment:{conceptId,nodeVersion:'a'.repeat(64),understandingPercent:percent,confidence,demonstrated:[],gaps:[],nextCheck:'Explain the mechanism.',needsReview:true}})
  const packet=taskTeachingContext({ids:['task'],catalog:base.catalogIds.map(id=>({id,title:id})),edges:base.edges,assessments:[assessment('root',0,'stale'),assessment('peer',0,'ready','insufficient'),assessment('mid',25)],suppressed:new Set(),gaps:[],foundationFirst:true})
  expect(packet.conceptIds).toEqual(['mid','task'])
  expect(packet.context).toContain('"understandingPercent":25')
  expect(packet.context).not.toContain('"understandingPercent":0')
})
