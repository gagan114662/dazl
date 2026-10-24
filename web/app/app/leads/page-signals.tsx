'use client'
import {useState} from 'react'
type Sig={kind:'team_task'|'named_stack'|'stated_problem'|'candidate_requirement';term:string;quote:string}
type Rd={chars_read:number;signals:Sig[];vendor_pitch:number;advice:number;unclear:number}
type Pg={url:string;role:'posting'|'company_home';status:'read'|'failed'|'not_used';why?:string;reading?:Rd}
type Res={company:string;topic:string;applies_to:string;pages:Pg[]}
const ROLE={posting:'the saved posting page',company_home:"the company's own home page"}
const KIND:Record<Sig['kind'],string>={team_task:'Work the posting says its own team or role does',named_stack:'A sales tool named in the posting',stated_problem:'The company says it is evaluating, replacing or struggling with something',candidate_requirement:'Asked of a job applicant (this does not show the team has a need)'}
export default function PageSignals({leadId}:{leadId:string}){
 const [r,setR]=useState<Res|null>(null),[busy,setBusy]=useState(false),[err,setErr]=useState('')
 async function go(){setBusy(true);setErr('')
 try{const x=await fetch(`/api/leads/page-signals?lead_id=${leadId}`);const b=await x.json();if(!x.ok){setErr(b.error||'Could not read.');return}setR(b)}catch{setErr('Could not read.')}finally{setBusy(false)}}
 return <div className="text-xs text-[#333] mt-2 mb-3">
 <button type="button" onClick={()=>void go()} disabled={busy} className="underline">{busy?'Reading...':'What the pages say about outbound prospecting (free, no AI call)'}</button>
 {err&&<span className="ml-2">{err}</span>}
 {r&&<div className="border-l-2 border-black/30 pl-3 mt-2 space-y-1">
 <p>Quotes are copied from the pages as they read now. This fixed word list was written for {r.applies_to} and is not matched to your offer. It looked only for {r.topic} words and sales tool names. dazl did not check what they mean, whether {r.company} needs anything, or whether it is a fit. This is not a score.</p>
 {r.pages.map(p=><div key={p.url} className="space-y-1">
 {p.status==='failed'&&<p>{ROLE[p.role]} could not be read ({p.why}).</p>}
 {p.status==='not_used'&&<p>{ROLE[p.role]} was read but not used: {p.why}.</p>}
 {p.status==='read'&&p.reading&&<>
 <p>{ROLE[p.role]}: read {p.reading.chars_read} characters. {p.reading.signals.length===0?'Nothing in that text matched. That is a result: the page may simply not say.':`${p.reading.signals.length} matching passage${p.reading.signals.length===1?'':'s'}:`}</p>
 {p.reading.signals.map((s,i)=><p key={i}><span className="font-mono">{KIND[s.kind]}</span> ({s.term}): "{s.quote}"</p>)}
 {p.reading.vendor_pitch>0&&<p>{p.reading.vendor_pitch} passage{p.reading.vendor_pitch===1?'':'s'} read like the company selling in this area, so it may be a competitor and not a buyer. Not shown as evidence.</p>}
 {p.reading.advice>0&&<p>{p.reading.advice} passage{p.reading.advice===1?'':'s'} read like general advice and were left out.</p>}
 {p.reading.unclear>0&&<p>{p.reading.unclear} more passage{p.reading.unclear===1?'':'s'} used these words with no clear subject and were left out.</p>}
 </>}
 </div>)}
 </div>}
 </div>
}
