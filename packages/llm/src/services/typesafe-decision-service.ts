import {z} from 'zod'
import {randomUUID} from 'node:crypto'
import {recordGeneration} from '../lib/llm/langfuse-generation.js'
import {DEFAULT_DECISION_SELECTION,resolveModelCapability,type AppModelSelection} from '../lib/llm/model-catalog.js'
import type {Concept} from '@learner/core/lib/learning/learning-concept-tag-experiment.js'
const ROUNDING_TOLERANCE=.005
export type TagInput={concepts:Concept[];text:string;context:Array<{role:string;text:string}>}
export class TagProviderFailure extends Error {constructor(message:string,public raw:string,public request:unknown){super(message)}}
const structured=z.union([z.string(),z.record(z.string(),z.unknown()),z.array(z.unknown())])
export const decisionQuestionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('noul'),instructions:structured,criteria:z.object({true:structured.optional(),false:structured.optional()}).optional()}).strict(),
 z.object({type:z.literal('choice'),instructions:structured,criteria:z.record(z.string(),structured.nullable()).refine(c=>Object.keys(c).length>=2&&Object.keys(c).length<=255)}).strict(),
 z.object({type:z.literal('score'),instructions:structured,criteria:z.array(structured).min(2).max(10)}).strict(),
])
export const decisionRequestSchema=z.object({state:structured,questions:z.record(z.string(),decisionQuestionSchema).refine(q=>Object.keys(q).length>0)}).strict()
export class TypeSafeDecisionService {
 readonly defaultSelection:AppModelSelection
 constructor(private readonly secret:string|undefined,private readonly http:DecisionHttp=fetch,selection:unknown=DEFAULT_DECISION_SELECTION){this.defaultSelection=resolveModelCapability(selection,'typed-decision').selection}
 assertConfigured(){if(!this.secret)throw new Error('Live provider credential not configured')}
 async evaluate(chosen:unknown,input:unknown){
  const {selection}=resolveModelCapability(chosen,'typed-decision'),request=decisionRequestSchema.parse(input)
  for(const question of Object.values(request.questions))resolveModelCapability(selection,question.type)
  this.assertConfigured()
  return evaluateDecisionHttp({...request,model:selection.model},this.http,this.secret)
 }
 async classify(input:TagInput,threshold:number,selection:unknown=this.defaultSelection){
  if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw new Error('Invalid threshold')
  const result=await this.evaluate(selection,conceptDecisionRequest(input))
  return {...result,ids:input.concepts.filter(c=>result.answers[c.ref].noul>=threshold).map(c=>c.id).sort()}
 }
}
export const conceptDecisionRequest=(input:TagInput)=>({state:input,questions:Object.fromEntries(input.concepts.map(c=>[c.ref,{type:'noul' as const,instructions:`Is the target human message substantively discussing ${c.title} (${c.domain})? Use context only to disambiguate the target; assistant-only mention is not relevant.`}]))})
// One Langfuse generation per call, refused ones included: Jev bills the input of
// a response our validator rejects, and Langfuse prices whatever usage it reports.
async function evaluateDecisionHttp(request:{model:string;state:unknown;questions:Record<string,any>},http:DecisionHttp,secret?:string){
 const startedAt=Date.now()
 let raw:string|null=null,failure:string|null=null
 try{return await evaluateDecisionResponse(request,http,secret,text=>{raw=text})}
 catch(error){failure=error instanceof Error?error.message:String(error);throw error}
 finally{
  let body:any=null
  try{body=raw===null?null:JSON.parse(raw)}catch{/* not JSON: no usage to record */}
  const usage=body?.usage
  void recordGeneration({callId:randomUUID(),system:'typesafe',model:typeof body?.model==='string'?body.model:request.model,startedAt,endedAt:Date.now(),usage:usage?{input:usage.input_tokens,output:usage.output_tokens}:null,failed:failure!==null,statusMessage:failure,label:'typed-decision',metadata:{requestedModel:request.model,billed:Boolean(usage),refusal:typeof body?.detail?.error_type==='string'?body.detail.error_type:null}})
 }
}
async function evaluateDecisionResponse(request:{model:string;state:unknown;questions:Record<string,any>},http:DecisionHttp,secret:string|undefined,onRaw:(raw:string)=>void){
 const response=await http('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{'content-type':'application/json',...(secret?{authorization:`Bearer ${secret}`}:{})},body:JSON.stringify(request),signal:AbortSignal.timeout(30000),redirect:'error'})
 const raw=await response.text()
 onRaw(raw)
 if(!response.ok)throw new TagProviderFailure(`Provider HTTP ${response.status}`,raw,request)
 let body:any
 try{body=JSON.parse(raw)}catch{throw new TagProviderFailure('Invalid Jev JSON',raw,request)}
 const fail=(message:string):never=>{throw new TagProviderFailure(message,raw,request)}
 const probability=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1
 if(!body||typeof body!=='object'||body.model!==request.model||!body.answers||JSON.stringify(Object.keys(body.answers).sort())!==JSON.stringify(Object.keys(request.questions).sort()))fail('Incomplete answers or model identity drift')
 for(const [key,question] of Object.entries(request.questions)){
  const a=body.answers[key]
  if(!a||a.type!==question.type)fail('Answer type mismatch')
  if(a.type==='noul'){if(!probability(a.noul))fail('Invalid probability');continue}
  // Jev reports 2-decimal probabilities, so a valid answer can miss 1 by up to half a cent per level.
  const keys=question.type==='choice'?Object.keys(question.criteria):question.criteria.map((_:unknown,i:number)=>String(i))
  if(!a.probabilities||Object.keys(a.probabilities).sort().join()!==keys.sort().join()||!Object.values(a.probabilities).every(probability)||Math.abs((Object.values(a.probabilities) as number[]).reduce((n,p)=>n+p,0)-1)>ROUNDING_TOLERANCE*keys.length||!probability(a.confidence))fail('Invalid probability distribution')
  if(a.type==='choice'&&!keys.includes(a.choice))fail('Invalid choice')
  if(a.type==='score'&&(!Number.isFinite(a.score)||a.score<0||a.score>keys.length-1||!a.legend||Object.keys(a.legend).sort().join()!==keys.sort().join()))fail('Invalid score')
 }
 return {answers:body.answers as Record<string,any>,raw,request,returnedModel:body.model as string,usage:body.usage??null}
}
export type DecisionHttp=(url:string,init:RequestInit)=>Promise<Response>
export async function classifyJev(input:TagInput,config:{mode:'mock'|'live';http?:DecisionHttp;secret?:string;model:string;threshold:number}){
 if(config.mode!=='mock'&&config.mode!=='live')throw new Error('Explicit provider mode required')
 if(config.mode==='live'&&!config.secret)throw new Error('Live provider credential not configured')
 if(config.mode==='mock'&&!config.http)throw new Error('Mock HTTP boundary required')
 if(!Number.isFinite(config.threshold)||config.threshold<0||config.threshold>1)throw new Error('Invalid threshold')
 const result=config.mode==='live'?await new TypeSafeDecisionService(config.secret,config.http??fetch).evaluate({provider:'typesafe',model:config.model},conceptDecisionRequest(input)):await evaluateDecisionHttp({model:config.model,...conceptDecisionRequest(input)},config.http!)
 return {...result,ids:input.concepts.filter(c=>result.answers[c.ref].noul>=config.threshold).map(c=>c.id).sort()}
}
/** Seam for existing structured generative dispatch: tagging only, no correction call. */
export async function classifyBaseline(input:TagInput,dispatch:(request:{input:TagInput;prompt:string;schema:unknown})=>Promise<string>){
 const request={input,prompt:'Return exactly {"refs":[]} containing every relevant supplied concept ref for the target human message. Context only disambiguates; do not tag assistant-only content. No reasons, evidence or mastery.',schema:{type:'object',properties:{refs:{type:'array',items:{type:'string',enum:input.concepts.map(c=>c.ref)},uniqueItems:true}},required:['refs'],additionalProperties:false}}
 const raw=await dispatch(request)
 let body:any
 try{body=JSON.parse(raw)}catch{throw new TagProviderFailure('Invalid baseline JSON',raw,request)}
 if(Object.keys(body).join()!=='refs'||!Array.isArray(body.refs)||new Set(body.refs).size!==body.refs.length||body.refs.some((r:unknown)=>typeof r!=='string'||!input.concepts.some(c=>c.ref===r)))throw new TagProviderFailure('Invalid baseline refs',raw,request)
 return {ids:body.refs.map((r:string)=>input.concepts.find(c=>c.ref===r)!.id).sort() as string[],raw,request,returnedModel:'synthetic-baseline-v1',usage:null}
}
