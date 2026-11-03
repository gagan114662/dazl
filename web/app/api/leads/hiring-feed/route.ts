import {NextRequest,NextResponse} from 'next/server'
import {getScanDb,requireUser} from '@/lib/scan/service'
import {sameOriginJson} from '@/lib/same-origin'
import {rateLimit} from '@/lib/rate-limit'
import {createHiringFeedIntake,hiringFeedStatus,JobFeedError,latestHiringFeedJob,retryHiringFeedContacts} from '@/lib/scan/job-feed'
import { denied } from '@/lib/workspace-access'

export async function GET(req:NextRequest){
 const user=await requireUser()
 if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const q=req.nextUrl.searchParams.get('job_id')
 const job=q===null?latestHiringFeedJob(getScanDb(),user.tenantId):q
 if(job===null)return NextResponse.json({job_id:null,contacts:[]})
 if(!/^[0-9a-f]{24}$/.test(job))return NextResponse.json({error:'Bad request'},{status:400})
 return NextResponse.json({job_id:job,contacts:hiringFeedStatus(getScanDb(),user.tenantId,job)})
}

export async function POST(req:NextRequest){
 const user=await requireUser()
 if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const no=denied(user,'operate');if(no)return no
 if(!sameOriginJson(req))return NextResponse.json({error:'Bad request'},{status:400})
 const raw=await req.text()
 if(raw.length>2000)return NextResponse.json({error:'That request is too large.'},{status:400})
 let body:{feed?:unknown;words?:unknown;retry_job_id?:unknown}
 try{body=JSON.parse(raw)}catch{return NextResponse.json({error:'Bad request'},{status:400})}
 if(!body||typeof body!=='object')return NextResponse.json({error:'Bad request'},{status:400})
 if(body.retry_job_id!==undefined){
 if(typeof body.retry_job_id!=='string'||!/^[0-9a-f]{24}$/.test(body.retry_job_id))return NextResponse.json({error:'Bad request'},{status:400})
 if(!(await rateLimit(`hiring-feed-retry:${user.tenantId}`,6,60*60*1000)).ok)return NextResponse.json({error:'Too many retries. Try again later.'},{status:429})
 const {crawl,...result}=await retryHiringFeedContacts(getScanDb(),user.tenantId,body.retry_job_id)
 void crawl
 return NextResponse.json(result,{status:202})
 }
 if(typeof body.feed!=='string')return NextResponse.json({error:'Pick one of the listed feeds.'},{status:400})
 if(!(await rateLimit(`hiring-feed:${user.tenantId}`,3,60*60*1000)).ok)return NextResponse.json({error:'Too many feed checks. Try again later.'},{status:429})
 try{
 const {crawl,...result}=await createHiringFeedIntake(getScanDb(),user.tenantId,body.feed,body.words)
 void crawl
 return NextResponse.json(result,{status:result.job_id?201:200})
 }catch(e){if(e instanceof JobFeedError)return NextResponse.json({error:e.message},{status:400});throw e}
}
