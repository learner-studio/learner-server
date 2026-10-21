import {createHash} from 'node:crypto'
export function tagCanonical(value:unknown):string {const normalize=(v:unknown):unknown=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,normalize(x)])):v;return JSON.stringify(normalize(value))}
export const tagHash=(value:unknown)=>createHash('sha256').update(tagCanonical(value)).digest('hex')
export type Concept={id:string;ref:string;title:string;domain:string}
export type TagCase={id:string;text:string;context:Array<{role:'user'|'assistant';text:string}>;gold:string[]}
export type TagArm='jev-mock'|'baseline-mock'|'jev-live'|'baseline-import'
export type TagManifest={modelSelection?:import('@learner/llm/lib/llm/model-catalog.js').AppModelSelection;providerMode:'mock'|'live';synthetic:boolean;historical?:any;curriculumId:string;concepts:Concept[];cases:TagCase[];arms:TagArm[];name:string;code:Record<string,string>;threshold:number}
export function scoreTags(gold:string[],predicted:string[],valid:boolean){
 const g=new Set(gold),p=new Set(valid?predicted:[])
 const tp=[...p].filter(id=>g.has(id)).length,fp=p.size-tp,fn=g.size-tp
 return {tp,fp,fn,message_f1:valid?(2*tp+fp+fn?2*tp/(2*tp+fp+fn):1):0,exact_match:Number(valid&&fp===0&&fn===0),valid_result:Number(valid),...(g.size?{}:{no_match_spurious:Number(p.size>0)})}
}
export function summarizeTags(rows:Array<{gold:string[];predicted:string[];valid:boolean;latencyMs:number}>){
 const scores=rows.map(r=>scoreTags(r.gold,r.predicted,r.valid)),sum=(key:'tp'|'fp'|'fn'|'message_f1'|'exact_match')=>scores.reduce((n,s)=>n+s[key],0)
 const tp=sum('tp'),fp=sum('fp'),fn=sum('fn'),times=rows.map(r=>r.latencyMs).sort((a,b)=>a-b)
 const supported=[...new Set(rows.flatMap(r=>r.gold))]
 return {count:rows.length,meanMessageF1:sum('message_f1')/rows.length,microPrecision:tp+fp?tp/(tp+fp):0,microRecall:tp+fn?tp/(tp+fn):0,microF1:2*tp+fp+fn?2*tp/(2*tp+fp+fn):0,exactMatchRate:sum('exact_match')/rows.length,failureRate:rows.filter(r=>!r.valid).length/rows.length,tp,fp,fn,p50:times[Math.ceil(times.length*.5)-1],p95:times[Math.ceil(times.length*.95)-1],perConcept:supported.map(id=>({id,support:rows.filter(r=>r.gold.includes(id)).length,...scoreTags(rows.flatMap((r,i)=>r.gold.includes(id)?[String(i)]:[]),rows.flatMap((r,i)=>r.valid&&r.predicted.includes(id)?[String(i)]:[]),true)}))}
}
