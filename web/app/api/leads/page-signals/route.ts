import {NextRequest,NextResponse} from 'next/server'
import {getScanDb,requireUser} from '@/lib/scan/service'
import {rateLimit} from '@/lib/rate-limit'
import {leadSignals} from '@/lib/scan/page-signals'

// Read-only. Fetches the lead's own public pages. Never calls a model and has no paid path.
export async function GET(req:NextRequest){
 const user=await requireUser()
 if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const id=req.nextUrl.searchParams.get('lead_id')??''
 if(!/^[0-9a-f]{24}$/.test(id))return NextResponse.json({error:'Bad request'},{status:400})
 if(!rateLimit(`page-signals:${user.id}`,20,60*60*1000).ok)return NextResponse.json({error:'Too many reads. Try again later.'},{status:429})
 const s=await leadSignals(getScanDb(),user.id,id)
 if(!s)return NextResponse.json({error:'Not found'},{status:404})
 return NextResponse.json(s)
}
