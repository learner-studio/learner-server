import type {Concept,TagCase,TagArm} from './learning-concept-tag-experiment.js'
import {classifyJev,classifyBaseline} from '@learner/llm/services/typesafe-decision-service.js'
export function syntheticTagCases(concepts:Concept[]):TagCase[]{
 if(concepts.length<3)throw new Error('Synthetic probe requires three concepts')
 const [a,b]=concepts as [Concept,Concept]
 return [{id:'01-positive',text:`I am studying ${a.title}.`,context:[],gold:[a.id]},{id:'02-multilabel',text:`I want to relate ${a.title} and ${b.title}.`,context:[],gold:[a.id,b.id]},{id:'03-none',text:'Hello, good morning.',context:[],gold:[]},{id:'04-assistant-only',text:'Thanks, goodbye.',context:[{role:'assistant',text:`Let us study ${b.title}.`}],gold:[]},{id:'05-missed',text:`Please explain ${b.title}.`,context:[],gold:[b.id]},{id:'06-invalid',text:`What does ${a.title} mean?`,context:[],gold:[a.id]}]
}
export function liveTagCases(concepts:Concept[]):TagCase[]{return syntheticTagCases(concepts).map(c=>({...c,id:c.id==='06-invalid'?'06-question':c.id==='05-missed'?'05-positive':c.id}))}
/** Deliberately imperfect endpoint fixture, injected at HTTP, never short-circuiting Jev validation. */
export async function syntheticTagProvider(concepts:Concept[],c:TagCase,arm:TagArm){
 if(arm==='jev-live')throw new Error('Live arm cannot use mock provider')
 const input={concepts,text:c.text,context:c.context},index=Number(c.id.slice(0,2))-1
 const refs=(arm==='jev-mock'?[[0],[0,2],[],[1],[],[]]:[[0],[0,1],[],[],[1],[]])[index]!.map(i=>concepts[i]!.ref)
 if(arm==='jev-mock')return classifyJev(input,{mode:'mock',model:'synthetic-jev-v1',threshold:.5,http:async(_url,init)=>{
 const request=JSON.parse(init.body as string)
 await Bun.sleep(4)
 return new Response(JSON.stringify({model:'synthetic-jev-v1',answers:index===5?{}:Object.fromEntries(Object.keys(request.questions).map(ref=>[ref,{type:'noul',noul:refs.includes(ref)?.9:.1}])),usage:{}}))
 }})
 return classifyBaseline(input,async()=>{await Bun.sleep(8);return index===5?'{"refs":["unknown-ref"]}':JSON.stringify({refs})})
}
