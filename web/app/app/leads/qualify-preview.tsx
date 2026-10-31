'use client'
import {useState} from 'react'
type Page={url:string;role:'posting'|'company_home';status:'fetched'|'failed';chars:number;fail?:string;used:boolean;not_used_reason?:string}
type Sent={url:string;chars_sent:number;chars_available:number;truncated:boolean}
type Judg={assessment_conflict?:{kind:string;premise?:string;note:string};verdict:string;quote:string|null;quote_url:string|null;note:string}
type Qual={company_fit:Judg;use_case:Judg;buying_evidence:Judg;caveat:string;evidence_scope:{pages_omitted:string[];any_truncated:boolean}}
type Ev={scope:{pages_included:Sent[]}|null;pages:Page[];cost:{usd_estimate_max:number|null}|null}
type Stored={prompt_sha256:string;status:'running'|'done'|'failed';vendor:string|null;model:string|null;created_at:number;evidence:Ev|null;qualification:Qual|null;error:string|null}
type Prev={company:string;vendor:string|null;model:string|null;pages:Page[];scope:{pages_included:Sent[]}|null;cost:{priced:boolean;usd_estimate_max:number|null;output_tokens_max:number}|null;ready:boolean;notes:string[];prompt_sha256:string|null;enabled:boolean;stored:Stored[]}
const ROLE={posting:'the saved posting page',company_home:"the company's own home page"}
const NAME={company_fit:'Company fit',use_case:'Use case for their own team',buying_evidence:'Buying evidence'} as const
const WORD:Record<string,string>={yes:'model assessment: yes',no:'model assessment: no',unknown:'model assessment: unknown (the model could not tell from the pages sent)',stated:'model assessment: stated',none_seen:'model assessment: none seen in the pages sent (this does not mean the company shows none elsewhere)'}
const hdr=(p:Prev)=>{const d=p.stored.some(s=>s.status==='done'),r=p.stored.some(s=>s.status==='running'),f=p.stored.some(s=>s.status==='failed');const pg=`the pages as they read now for ${p.company} (not necessarily what the earlier request read)`;if(d)return `A completed fit check is shown below; it sent the pages listed here to an AI service. These are ${pg}:`;if(r)return `A fit check was started and has not finished. Whether the pages were sent, and whether it will be billed, is not known yet. These are ${pg}:`;if(f)return `A fit check was started and failed. Whether the pages were sent, and whether it was billed, is unknown. These are ${pg}:`;return `No fit check request is recorded for this lead. These are ${pg} (a fit check would read them):`}
export default function QualifyPreview({leadId}:{leadId:string}){
 const [p,setP]=useState<Prev|null>(null),[busy,setBusy]=useState(false),[err,setErr]=useState('')
 async function go(){setBusy(true);setErr('')
 try{const r=await fetch(`/api/leads/qualify-preview?lead_id=${leadId}`);const b=await r.json();if(!r.ok){setErr(b.error||'Could not check.');return}setP(b)}catch{setErr('Could not check.')}finally{setBusy(false)}}
 async function run(){if(!p||!p.cost||!p.prompt_sha256||!p.vendor||!p.model||p.cost.usd_estimate_max===null)return;setBusy(true);setErr('')
 try{const r=await fetch('/api/leads/qualify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lead_id:leadId,approval:{approved_by_user:true,vendor:p.vendor,model:p.model,max_usd_estimate:p.cost.usd_estimate_max,prompt_sha256:p.prompt_sha256,limits:{max_input_chars:12000,max_page_chars:4000,max_output_tokens:p.cost.output_tokens_max}}})});const b=await r.json();if(!r.ok&&r.status!==409){setErr(b.error||'The check did not run.');return}if(r.status===409){setErr('The check did not run: '+(b.reason||'blocked'));return}await go()}catch{setErr('The check did not run.')}finally{setBusy(false)}}
 const sent=(u:string)=>p?.scope?.pages_included.find(x=>x.url===u)
 const shown=p?.notes.filter(n=>!/^No verified price|^No AI key/.test(n))??[]
 return <div className="text-xs text-[#333] mt-2 mb-3">
 <button type="button" onClick={()=>void go()} disabled={busy} className="underline">{busy?'Looking...':'What a fit check would read (free, no AI call)'}</button>
 {err&&<span className="ml-2">{err}</span>}
 {p&&<div className="border-l-2 border-black/30 pl-3 mt-2 space-y-1">
 <p>{hdr(p)}</p>
 {p.pages.map(x=>{const s=sent(x.url);return <p key={x.url}>{ROLE[x.role]}: {x.status==='failed'?`could not be read (${x.fail??'error'})`:!x.used?`read but not used: ${x.not_used_reason}`:s?`${p.stored.length?'now':'would be sent:'} ${s.chars_sent} of ${s.chars_available} characters${s.truncated?' (the rest is cut off and would not be read)':''}`:`${x.chars} characters`}</p>})}
 <p>{p.cost&&p.cost.priced&&p.cost.usd_estimate_max!==null?`Estimated cost on your ${p.vendor} key: about $${p.cost.usd_estimate_max.toFixed(4)}. This is an estimate, not a guaranteed cap.`:'No price estimate is available: '+(p.vendor?`there is no verified price for ${p.vendor}${p.model?' '+p.model:''}.`:'no AI key is saved.')}</p>
 {shown.map(n=><p key={n}>{n}</p>)}
 {p.enabled&&p.ready&&p.stored.length===0?<p><button type="button" onClick={()=>void run()} disabled={busy} className="font-mono uppercase border border-black px-2 py-1">Run fit check - estimated cost ${p.cost?.usd_estimate_max?.toFixed(4)}</button></p>:<p>{p.enabled?'':'Running the check is not available yet. '}A quote match would only show that the words appear on a page. It would not prove fit or a buying need.</p>}
 {p.stored.map(s=><div key={s.prompt_sha256} className="mt-2 space-y-1">
 <p className="font-mono">Earlier request{s.vendor?` on ${s.vendor}${s.model?' '+s.model:''}`:''}, {new Date(s.created_at*1000).toISOString().slice(0,16).replace('T',' ')} UTC, content id {s.prompt_sha256.slice(0,8)}{s.prompt_sha256!==p.prompt_sha256?' - the pages have changed since, so the current pages above are not what it read':''}.</p>
 {s.evidence?.scope?s.evidence.scope.pages_included.map(e=><p key={e.url}>It was given {e.chars_sent} of {e.chars_available} characters of {e.url}{e.truncated?' (the rest was cut off)':''}. The page text itself was not saved.</p>):<p>The evidence given to it was not recorded.</p>}
 {s.evidence?.cost?.usd_estimate_max!=null&&<p>Estimated cost when requested: about ${s.evidence.cost.usd_estimate_max.toFixed(4)} (an estimate, not the billed amount).</p>}
 {s.status==='failed'&&<p>Failed ({s.error}). It will not run again by itself, because it may have been sent and billed.</p>}{s.status==='running'&&<p>Still running or interrupted. It will not be started again by itself.</p>}
 {s.qualification&&(Object.keys(NAME) as (keyof typeof NAME)[]).map(k=>{const j=s.qualification![k];return <p key={k}>{NAME[k]}: {WORD[j.verdict]??j.verdict}{j.assessment_conflict&&<strong className="block">{j.assessment_conflict.note}{j.assessment_conflict.premise&&<> Flagged comparison: "{j.assessment_conflict.premise}".</>}</strong>}{j.quote&&<> - model-cited quote "{j.quote}" (found on {j.quote_url}; the model's reading of it is not verified)</>}{j.note?` ${j.note}`:''}</p>})}
 {s.qualification&&<p>{s.qualification.caveat}{s.qualification.evidence_scope.any_truncated?' Some page text was cut off or left out, so "none seen" only covers the text that was sent.':''}</p>}
 </div>)}
 </div>}
 </div>
}
