import {NextRequest,NextResponse} from 'next/server'
import {getScanDb,requireUser} from '@/lib/scan/service'
import {getAuthDb,sellerProfile} from '@/lib/auth-db'
import {rateLimit} from '@/lib/rate-limit'
import {qualifyPreview} from '@/lib/scan/qualify-preview'
import {storedQualifications} from '@/lib/scan/qualify-run'
import {fetchPageDetailed} from '@/lib/scan/fetch-page'
import {providers} from '@/lib/llm/provider'
import {pickVendor} from '@/lib/scan/runner'

// Read-only. Fetches public pages only. Never calls a model and has no paid path.
export async function GET(req:NextRequest){
 const user=await requireUser()
 if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const id=req.nextUrl.searchParams.get('lead_id')??''
 if(!/^[0-9a-f]{24}$/.test(id))return NextResponse.json({error:'Bad request'},{status:400})
 if(!(await rateLimit(`qualify-preview:${user.tenantId}`,20,60*60*1000)).ok)return NextResponse.json({error:'Too many previews. Try again later.'},{status:429})
 const vendor=pickVendor(getScanDb(),user.tenantId)
 const p=await qualifyPreview(getScanDb(),user.tenantId,id,sellerProfile(getAuthDb(),user.tenantId),fetchPageDetailed,vendor,vendor?providers[vendor].configuredModel?.()??null:null)
 if(!p)return NextResponse.json({error:'Not found'},{status:404})
 const {input,...pub}=p;void input
 return NextResponse.json({...pub,model_call:false,enabled:process.env.DAZL_QUALIFY_ENABLED==='1',stored:storedQualifications(getScanDb(),user.tenantId,id)})
}
