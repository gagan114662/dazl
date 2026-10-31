// Ephemeral request packing provenance. No storage, semantic interpretation or owner approval.
import { createHash } from 'node:crypto'
import { parseIcp, fallbackIcp } from './icp.ts'
import { icpTextFor } from './score.ts'
export interface RequestPacking {
 raw_request: string; profile_origin: 'stored_profile' | 'request_fallback'; approval_provenance: 'unrecorded'
 derived_criteria: string; sent_criteria: string; complete: boolean; issues: string[]; context_sha256: string
}
const clean=(s:string)=>s.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()
export function packRequest(query:string,stored:string|null,cap:number):RequestPacking {
 const parsed=stored?parseIcp(stored):null
 const profile=parsed??fallbackIcp(query),derived=icpTextFor(profile,query)
 const issues:string[]=[]
 if(stored&&!parsed)issues.push('The stored profile could not be read; the request fallback is not a complete representation of that profile.')
 if(!parsed&&clean(query)!==profile.summary)issues.push('The request fallback drops text before the prompt is prepared.')
 if(parsed&&stored){
  try{
   const obj=JSON.parse(stored.slice(stored.indexOf('{'),stored.lastIndexOf('}')+1))
   if(typeof obj.summary!=='string'||clean(obj.summary)!==parsed.summary)issues.push('Stored profile summary text was dropped or shortened during normalization.')
   for(const key of ['who','industries','sizes','where','signals','exclude'] as const){
    const xs=obj[key]
    if(xs!==undefined&&(!Array.isArray(xs)||xs.some((x:unknown)=>typeof x!=='string')||JSON.stringify(xs.map((x:string)=>clean(x)))!==JSON.stringify(parsed[key])))issues.push(`Stored profile ${key} entries were dropped or shortened during normalization.`)
   }
  }catch{issues.push('Stored profile normalization could not be compared.')}
 }
 if(derived.length>cap)issues.push('The criteria text exceeds the existing prompt field cap; some criteria would not be sent.')
 const sent=derived.slice(0,cap)
 return{raw_request:query,profile_origin:parsed?'stored_profile':'request_fallback',approval_provenance:'unrecorded',derived_criteria:derived,sent_criteria:sent,complete:issues.length===0,issues,context_sha256:createHash('sha256').update(JSON.stringify({query,stored,derived,sent})).digest('hex')}
}
