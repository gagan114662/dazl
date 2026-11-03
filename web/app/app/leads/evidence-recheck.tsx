'use client'
import {useState} from 'react'
type Result={company:string;offer:string|null;checked_at:number;source_url:string;reasons:string[];status:string}
export default function EvidenceRecheck({leadId}:{leadId:string}){
 const[result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 async function check(){setBusy(true);setError('');setResult(null)
 try{const r=await fetch(`/api/leads/evidence-recheck?lead_id=${leadId}`,{cache:'no-store'});const b=await r.json();if(!r.ok){setError(b.error??'Could not check. Nothing changed.');return}setResult(b)}catch{setError('Could not check. Nothing changed.')}finally{setBusy(false)}}
 return <div className="text-xs text-[#333] mt-2" data-testid="evidence-recheck">
 <button type="button" className="underline" disabled={busy} onClick={()=>void check()}>{busy?'Reading saved source...':'Recheck saved source (free, no AI call)'}</button>
 {error&&<p role="status">{error}</p>}
 {result&&<div className="border-l-2 border-black/30 pl-3 mt-2 space-y-1" role="status">
 <p>Saved-source check for {result.company}, {new Date(result.checked_at*1000).toISOString().slice(0,16).replace('T',' ')} UTC. This play sells: {result.offer??'unresolved'}.</p>
 {result.reasons.map((reason,i)=><p key={i}>{reason}</p>)}
 <p><a href={result.source_url} target="_blank" rel="noopener noreferrer nofollow" className="underline">Open the saved source</a>. No scan, AI request, draft or eligibility change.</p>
 </div>}
 </div>
}
