import {NextRequest,NextResponse} from 'next/server'
import {requireUser,getScanDb} from '@/lib/scan/service'
import {sameOriginJson} from '@/lib/same-origin'
import {rateLimit} from '@/lib/rate-limit'
import {denied} from '@/lib/workspace-access'
import {savePlayResearch,playResearchCards,PlayResearchError} from '@/lib/scan/play-research'
import {SourceReviewError} from '@/lib/scan/source-review'
export async function GET(req:NextRequest){
 const user=await requireUser();if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const job=req.nextUrl.searchParams.get('job_id')??''
 if(!/^[a-f0-9]{24}$/.test(job))return NextResponse.json({error:'Play not found'},{status:404})
 return NextResponse.json({job_id:job,research:playResearchCards(getScanDb(),user.tenantId,job)})
}
export async function POST(req:NextRequest){
 const user=await requireUser();if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const no=denied(user,'operate');if(no)return no
 let sameOrigin=false;try{sameOrigin=sameOriginJson(req)}catch{}
 if(!sameOrigin)return NextResponse.json({error:'Bad request'},{status:400})
 const limit=await rateLimit(`play-research:${user.tenantId}`,10,60*60*1000)
 if(!limit.ok)return NextResponse.json({error:limit.unavailable?'Source check limit is temporarily unavailable. Try again later.':'Too many source checks. Try again later.'},{status:limit.unavailable?503:429,headers:{'Retry-After':String(limit.retryAfterS)}})
 const text=await req.text();if(text.length>10000)return NextResponse.json({error:'That research is too large.'},{status:400})
 let raw:Record<string,unknown>;try{raw=JSON.parse(text);if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error()}catch{return NextResponse.json({error:'Bad request'},{status:400})}
 if(typeof raw.job_id!=='string'||!/^[a-f0-9]{24}$/.test(raw.job_id))return NextResponse.json({error:'Play not found'},{status:404})
 try{return NextResponse.json(await savePlayResearch(getScanDb(),user.tenantId,raw.job_id,raw),{status:201})}catch(e){if(e instanceof PlayResearchError||e instanceof SourceReviewError)return NextResponse.json({error:e.message},{status:400});throw e}
}
