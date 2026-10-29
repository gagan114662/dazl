import {NextRequest,NextResponse} from 'next/server'
import {getScanDb,requireUser} from '@/lib/scan/service'
import {getAuthDb,sellerProfile} from '@/lib/auth-db'
import {sameOriginJson} from '@/lib/same-origin'
import {rateLimit} from '@/lib/rate-limit'
import {providers} from '@/lib/llm/provider'
import {readKey} from '@/lib/llm/key-store'
import {pickVendor} from '@/lib/scan/runner'
import {runQualification} from '@/lib/scan/qualify-run'
import { denied } from '@/lib/workspace-access'

// Off by default. Runs one paid model request only when DAZL_QUALIFY_ENABLED=1 AND the body carries an
// approval bound to the exact prompt hash, vendor, model, estimate and limits the user was shown.
export async function POST(req:NextRequest){
 const user=await requireUser()
 if(!user)return NextResponse.json({error:'Not signed in'},{status:401})
 const no=await denied(user,'operate');if(no)return no
 if(process.env.DAZL_QUALIFY_ENABLED!=='1')return NextResponse.json({error:'Fit checks are not available yet.'},{status:503})
 if(!sameOriginJson(req))return NextResponse.json({error:'Bad request'},{status:400})
 const raw=await req.text()
 if(raw.length>2000)return NextResponse.json({error:'Bad request'},{status:400})
 let b:{lead_id?:unknown;approval?:Record<string,unknown>}
 try{b=JSON.parse(raw)}catch{return NextResponse.json({error:'Bad request'},{status:400})}
 const a=b?.approval
 if(typeof b?.lead_id!=='string'||!/^[0-9a-f]{24}$/.test(b.lead_id)||!a||a.approved_by_user!==true||typeof a.vendor!=='string'||typeof a.model!=='string'||typeof a.max_usd_estimate!=="number"||!Number.isFinite(a.max_usd_estimate)||a.max_usd_estimate<0||typeof a.prompt_sha256!=='string'||!a.limits||typeof a.limits!=='object')return NextResponse.json({error:'Bad request'},{status:400})
 if(!(await rateLimit(`qualify:${user.tenantId}`,5,60*60*1000)).ok)return NextResponse.json({error:'Too many checks. Try again later.'},{status:429})
 const db=getScanDb(),vendor=pickVendor(db,user.tenantId)
 const k=vendor?readKey(db,user.tenantId,vendor):{key:null,unreadable:false}
 const r=await runQualification(db,user.tenantId,b.lead_id,a as never,{enabled:true,sellerText:sellerProfile(getAuthDb(),user.tenantId),vendor,provider:vendor?providers[vendor]:null,apiKey:k.key})
 return NextResponse.json(r,{status:r.status==='done'||r.status==='exists'?200:r.status==='failed'?502:409})
}
