import {NextRequest,NextResponse} from 'next/server'
import {getScanDb,requireUser} from '@/lib/scan/service'
import {getAuthDb,sellerProfile} from '@/lib/auth-db'
import {rateLimit} from '@/lib/rate-limit'
import {qualifyPreview} from '@/lib/scan/qualify-preview'
import {fetchPageDetailed} from '@/lib/scan/fetch-page'
import {anthropicProvider} from '@/lib/llm/provider'

// Read-only. Fetches public pages only. Never calls a model and has no paid path.
export async function GET(req:NextRequest){
 const user=await requireUser()
 if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const id=req.nextUrl.searchParams.get('lead_id')??''
 if(!/^[0-9a-f]{24}$/.test(id))return NextResponse.json({error:'Bad request'},{status:400})
 if(!rateLimit(`qualify-preview:${user.id}`,20,60*60*1000).ok)return NextResponse.json({error:'Too many previews. Try again later.'},{status:429})
 const p=await qualifyPreview(getScanDb(),user.id,id,sellerProfile(getAuthDb(),user.id),fetchPageDetailed,anthropicProvider.configuredModel?.()??null)
 if(!p)return NextResponse.json({error:'Not found'},{status:404})
 return NextResponse.json({...p,model_call:false})
}
