'use client'
import {useEffect,useState} from 'react'
import type {PlayResearchCard} from '@/lib/scan/play-research'
const EMPTY={company:'',signal:'',source_url:'',excerpt:'',event_date:'',contact:'',person_name:'',person_role:'',professional_url:'',person_excerpt:''}
export default function PlayResearch({jobId}:{jobId:string}){
 const [value,setValue]=useState(EMPTY),[cards,setCards]=useState<PlayResearchCard[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loadedFor,setLoadedFor]=useState('')
 useEffect(()=>{let active=true;setCards([]);setLoadedFor('');setError('');setValue(EMPTY)
 void fetch(`/api/leads/play-research?job_id=${jobId}`).then(async r=>{if(!r.ok)throw Error('Could not read saved research.');return r.json()}).then(j=>{if(active){setCards(j.research);setLoadedFor(jobId)}}).catch(()=>{if(active)setError('Could not read saved research. Reload to try again.')})
 return()=>{active=false}
 },[jobId])
 async function save(e:React.FormEvent){e.preventDefault();setBusy(true);setError('')
 try{const r=await fetch('/api/leads/play-research',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...value,job_id:jobId})});const j=await r.json();if(!r.ok)throw Error(j.error||'Could not save research.')
 const list=await fetch(`/api/leads/play-research?job_id=${jobId}`);if(!list.ok)throw Error('Saved, but could not reload research. Reload this play.');const data=await list.json();setCards(data.research);setValue(EMPTY)
 }catch(e){setError(e instanceof Error?e.message:'Could not save research.')}finally{setBusy(false)}}
 return <section data-testid="play-research" className="card p-5 my-4 space-y-3 text-sm">
 <h2 className="font-medium">Research saved to this play</h2>
 <p className="text-xs text-[#555]">Supplemental research, separate from this scan&apos;s results. No verified fit, buying intent or consent. Professional contact links are not email recipients. These cards cannot be approved, drafted, sent or counted as qualified leads.</p>
 {error&&<p role="alert" className="text-xs">{error}</p>}
 {loadedFor===jobId&&cards.length===0&&<p className="text-xs text-[#555]">No supplemental research saved.</p>}
 {loadedFor===jobId&&cards.map(c=><article key={c.id} className="border border-[var(--line)] rounded-xl p-4 space-y-2" data-testid="play-research-card">
 <div className="flex flex-wrap gap-2 items-center"><h3 className="font-medium">{c.company}</h3><span className="chip text-xs">Research only - not draft ready</span></div>
 <p>{c.signal}</p><p className="text-xs">Claimed event or announcement date: {c.event_date||'Not supplied'}. Supplied claim, not verified timing.</p>
 <a className="underline break-all text-xs" href={c.source_url} target="_blank" rel="noopener noreferrer nofollow">Source: {c.source_url}</a>
 <details className="text-xs"><summary className="cursor-pointer">Source quote and check</summary><blockquote className="border-l-2 pl-3 whitespace-pre-wrap mt-2">{c.excerpt}</blockquote>
 <p className="text-xs">Literal source check: {c.source_check.fetch_status}; quote {c.source_check.quote_match?'matched':'not confirmed'}; company in quote {c.source_check.company_named?'yes':'not confirmed'}. Literal checks do not verify the claim. Checked: {new Date(c.source_check.checked_at*1000).toISOString()}.</p></details>
 {c.person_name&&<div className="text-xs space-y-1"><p>{c.person_name}, {c.person_role} (supplied role)</p><a className="underline break-all" href={c.professional_url} target="_blank" rel="noopener noreferrer nofollow">Professional source: {c.professional_url}</a><details><summary className="cursor-pointer">Professional source quote and check</summary><blockquote className="border-l-2 pl-3 whitespace-pre-wrap mt-2">{c.person_excerpt}</blockquote><p>Professional source check: {c.person_check?.fetch_status||'not checked'}; quote {c.person_check?.quote_match?'matched':'not confirmed'}. Current role and company association are not verified.</p></details></div>}
 <p className="text-xs">Email claim: {c.email_claim||'No email supplied'}. Not verified as a recipient; no draft is available from this card.</p>
 <details className="text-xs"><summary>Play context when saved</summary><p className="whitespace-pre-wrap">Request: {c.query_snapshot}</p><p>Offer: {c.offer_snapshot} (source: {c.offer_source})</p><p>Original play anchor: {new Date(c.play_created_at*1000).toISOString()}. The research does not reset its search window.</p></details>
 </article>)}
 <details><summary className="cursor-pointer text-xs">Save source-backed research to this play (no paid call)</summary>
 <form onSubmit={e=>void save(e)} className="space-y-3 mt-3">
 <p className="text-xs">Save a claim and its public source without changing the finished scan or its leads. The play&apos;s original request and effective offer are kept with the research. Exact quote checks only, not qualification.</p>
 {([['company','Company',150],['signal','Signal claim',500],['source_url','Public HTTPS source URL',500],['excerpt','Exact source quote (20-400 characters)',400],['event_date','Claimed event or announcement date (YYYY-MM-DD, optional)',10],['contact','Email printed on the source (optional claim, not a recipient)',254],['person_name','Person name (optional)',150],['person_role','Person role',150],['professional_url','Professional source URL (HTTPS, separate from email)',500],['person_excerpt','Exact professional source quote (20-400 characters)',400]] as const).map(([key,label,max])=><label className="block text-xs" key={key}>{label}{key==='excerpt'||key==='signal'||key==='person_excerpt'?<textarea className="field w-full mt-1" rows={3} maxLength={max} required={key==='excerpt'||key==='signal'} minLength={key==='excerpt'?20:undefined} value={value[key]} onChange={e=>setValue({...value,[key]:e.target.value})}/>:<input className="field w-full mt-1" maxLength={max} required={key==='company'||key==='source_url'} value={value[key]} onChange={e=>setValue({...value,[key]:e.target.value})}/>}</label>)}
 <button disabled={busy||loadedFor!==jobId} className="btn-primary btn-sm disabled:opacity-40">{busy?'Checking and saving...':'Save research only'}</button>
 </form></details>
 </section>
}
