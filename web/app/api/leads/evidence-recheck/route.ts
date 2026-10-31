import {NextRequest,NextResponse} from 'next/server'
import {getScanDb,requireUser} from '@/lib/scan/service'
import {rateLimit} from '@/lib/rate-limit'
import {evidenceRecheck} from '@/lib/scan/evidence-recheck'
export async function GET(req:NextRequest){
 const user=await requireUser();if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const id=req.nextUrl.searchParams.get('lead_id')??''
 if(!/^[a-f0-9]{24}$/.test(id))return NextResponse.json({error:'Bad request'},{status:400})
 const limit=await rateLimit(`evidence-recheck:${user.tenantId}`,20,60*60*1000)
 if(limit.unavailable)return NextResponse.json({error:'Checks are briefly unavailable.'},{status:503})
 if(!limit.ok)return NextResponse.json({error:'Too many checks. Try again later.'},{status:429})
 try{const result=await evidenceRecheck(getScanDb(),user.tenantId,id);return result?NextResponse.json(result):NextResponse.json({error:'Not found'},{status:404})}
 catch{return NextResponse.json({error:'The saved context could not be checked. Nothing changed.'},{status:503})}
}
