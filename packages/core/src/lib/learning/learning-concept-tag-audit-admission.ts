type Job={runId:string;caseId:string;arm:string;jobKey:string}
type Dependencies={find:(queue:string,key:string)=>Promise<Array<{id:string}>>;add:(queue:string,job:Job,options:{jobId:string;attempts:number})=>Promise<string>}
export async function admitTagAudit(job:Job,deps:Dependencies){
 const queue='learning.concept-tag-audit',key=`audit:${job.jobKey}`,old=await deps.find(queue,key)
 if(old.length>1)throw new Error('Duplicate durable audit job')
 const auditJobId=old[0]?.id??await deps.add(queue,job,{jobId:key,attempts:3})
 return {auditJobId,state:'queued'}
}
