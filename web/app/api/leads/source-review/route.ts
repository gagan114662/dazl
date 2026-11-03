import {NextRequest,NextResponse} from 'next/server'
import {getScanDb,requireUser} from '@/lib/scan/service'
import {sameOriginJson} from '@/lib/same-origin'
import {rateLimit} from '@/lib/rate-limit'
import {createSourceReview,parseSourceReview,SourceReviewError} from '@/lib/scan/source-review'
import { denied } from '@/lib/workspace-access'

export async function POST(req:NextRequest){
 const user=await requireUser()
 if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const no=denied(user,'operate');if(no)return no
 if(!sameOriginJson(req))return NextResponse.json({error:'Bad request'},{status:400})
 if(!(await rateLimit(`source-review:${user.tenantId}`,10,60*60*1000)).ok)return NextResponse.json({error:'Too many source checks. Try again later.'},{status:429})
 const raw=await req.text()
 if(raw.length>8000)return NextResponse.json({error:'That source review is too large.'},{status:400})
 let body:unknown
 try{body=JSON.parse(raw)}catch{return NextResponse.json({error:'Bad request'},{status:400})}
 try{
 const input=parseSourceReview(body)
 const result=await createSourceReview(getScanDb(),user.tenantId,input)
 return NextResponse.json(result,{status:201})
 }catch(e){if(e instanceof SourceReviewError)return NextResponse.json({error:e.message},{status:400});throw e}
}
