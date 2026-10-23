import {NextRequest,NextResponse} from 'next/server'
import {getScanDb,requireUser} from '@/lib/scan/service'
import {sameOriginJson} from '@/lib/same-origin'
import {rateLimit} from '@/lib/rate-limit'
import {createHiringFeedIntake,JobFeedError} from '@/lib/scan/job-feed'

export async function POST(req:NextRequest){
 const user=await requireUser()
 if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 if(!sameOriginJson(req))return NextResponse.json({error:'Bad request'},{status:400})
 if(!rateLimit(`hiring-feed:${user.id}`,3,60*60*1000).ok)return NextResponse.json({error:'Too many feed checks. Try again later.'},{status:429})
 const raw=await req.text()
 if(raw.length>2000)return NextResponse.json({error:'That request is too large.'},{status:400})
 let body:{feed?:unknown;words?:unknown}
 try{body=JSON.parse(raw)}catch{return NextResponse.json({error:'Bad request'},{status:400})}
 if(!body||typeof body!=='object'||typeof body.feed!=='string')return NextResponse.json({error:'Pick one of the listed feeds.'},{status:400})
 try{
 const result=await createHiringFeedIntake(getScanDb(),user.id,body.feed,body.words)
 return NextResponse.json(result,{status:result.job_id?201:200})
 }catch(e){if(e instanceof JobFeedError)return NextResponse.json({error:e.message},{status:400});throw e}
}
