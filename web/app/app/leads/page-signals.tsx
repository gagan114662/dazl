'use client'
import {useState} from 'react'
type Ph={duty:string|null;requirement:string|null;self_description:string|null;evaluation:string|null;negation:string|null}
type Ps={terms:string[];quote:string;phrases:Ph}
type Rd={chars_read:number;passages:Ps[];passages_total:number}
type Pg={url:string;role:'posting'|'company_home';status:'read'|'failed'|'not_used';why?:string;reading?:Rd}
type Res={company:string;topic:string;applies_to:string;looked_for:{task_terms:string[];stack_names:string[]};pages:Pg[]}
const ROLE={posting:'the saved posting page',company_home:"the company's own home page"}
const LABEL:Record<keyof Ph,string>={duty:'a duty-style phrase',requirement:'a requirement-style phrase',self_description:"a phrase about the company's own product",evaluation:'an evaluation-style word',negation:'a negation word'}
export default function PageSignals({leadId}:{leadId:string}){
 const [r,setR]=useState<Res|null>(null),[busy,setBusy]=useState(false),[err,setErr]=useState('')
 async function go(){setBusy(true);setErr('')
 try{const x=await fetch(`/api/leads/page-signals?lead_id=${leadId}`);const b=await x.json();if(!x.ok){setErr(b.error||'Could not read.');return}setR(b)}catch{setErr('Could not read.')}finally{setBusy(false)}}
 return <div className="text-xs text-[#333] mt-2 mb-3">
 <button type="button" onClick={()=>void go()} disabled={busy} className="underline">{busy?'Reading...':'Passages on the pages that use outbound-prospecting words (free, no AI call)'}</button>
 {err&&<span className="ml-2">{err}</span>}
 {r&&<div className="border-l-2 border-black/30 pl-3 mt-2 space-y-1">
 <p>Passages are copied from the pages as they read now, for you to read. dazl did not work out who a passage is about, whether it is negated, or whether {r.company} needs anything or is a fit. It is not a score and not evidence. The fixed word list was written for {r.applies_to} and is not matched to your offer.</p>
 <p>Words looked for: {r.looked_for.task_terms.join(', ')}. Tool names looked for: {r.looked_for.stack_names.join(', ')}. Nothing else.</p>
 {r.pages.map(p=><div key={p.url} className="space-y-1">
 {p.status==='failed'&&<p>{ROLE[p.role]} could not be read ({p.why}).</p>}
 {p.status==='not_used'&&<p>{ROLE[p.role]} was read but not used: {p.why}.</p>}
 {p.status==='read'&&p.reading&&<>
 <p>{ROLE[p.role]}: read {p.reading.chars_read} characters. {p.reading.passages_total===0?'None of those words or tool names appear. That is a result about this page text only.':`${p.reading.passages_total} passage${p.reading.passages_total===1?'':'s'} contain them${p.reading.passages_total>p.reading.passages.length?` (first ${p.reading.passages.length} shown)`:''}:`}</p>
 {p.reading.passages.map((s,i)=>{const found=(Object.keys(LABEL) as (keyof Ph)[]).filter(k=>s.phrases[k]).map(k=>`${LABEL[k]} "${s.phrases[k]}"`);return <p key={i}>"{s.quote}" - contains: {s.terms.join(', ')}.{found.length?` Also contains ${found.join('; ')}.`:''}</p>})}
 </>}
 </div>)}
 </div>}
 </div>
}
