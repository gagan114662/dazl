'use client'
import {useState} from 'react'
type Page={url:string;role:'posting'|'company_home';status:'fetched'|'failed';chars:number;fail?:string;used:boolean;not_used_reason?:string}
type Prev={company:string;vendor:string|null;model:string|null;seller_offer_present:boolean;pages:Page[];cost:{priced:boolean;usd_estimate_max:number|null;bytes:number;output_tokens_max:number}|null;ready:boolean;notes:string[]}
const ROLE={posting:'the saved posting page',company_home:"the company's own home page"}
export default function QualifyPreview({leadId}:{leadId:string}){
 const [p,setP]=useState<Prev|null>(null),[busy,setBusy]=useState(false),[err,setErr]=useState('')
 async function go(){setBusy(true);setErr('')
 try{const r=await fetch(`/api/leads/qualify-preview?lead_id=${leadId}`);const b=await r.json();if(!r.ok){setErr(b.error||'Could not check.');return}setP(b)}catch{setErr('Could not check.')}finally{setBusy(false)}}
 return <div className="text-xs text-[#333] mt-2">
 <button type="button" onClick={()=>void go()} disabled={busy} className="underline">{busy?'Looking...':'What a fit check would read (free, no AI call)'}</button>
 {err&&<span className="ml-2">{err}</span>}
 {p&&<div className="border-l-2 border-black/30 pl-3 mt-2 space-y-1">
 <p>Nothing was sent to an AI service. These are the pages a fit check would read for {p.company}:</p>
 {p.pages.map(x=><p key={x.url}>{ROLE[x.role]}: {x.status==='failed'?`could not be read (${x.fail??'error'})`:x.used?`will be read (${x.chars} characters, cut to fit a limit)`:`read but not used: ${x.not_used_reason}`}</p>)}
 <p>{p.cost&&p.cost.priced&&p.cost.usd_estimate_max!==null?`Estimated most it could cost on your ${p.vendor} key: about $${p.cost.usd_estimate_max.toFixed(4)}. This is an estimate, not a guaranteed cap.`:'No price estimate is available: '+(p.vendor?`there is no verified price for ${p.vendor}${p.model?' '+p.model:''}.`:'no AI key is saved.')}</p>
 {p.notes.map(n=><p key={n}>{n}</p>)}
 <p>Checking is not available from this page yet. A match would only show that a quote appears on a page. It would not prove fit or a buying need.</p>
 </div>}
 </div>
}
