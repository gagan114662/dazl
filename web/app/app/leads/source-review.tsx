'use client'
import {useState} from 'react'
export default function SourceReview(){
 const [value,setValue]=useState({company:'',signal:'',source_url:'',excerpt:'',contact:'',event_date:''})
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const [result,setResult]=useState<{job_id:string;check:{fetch_status:string;quote_match:boolean;company_named:boolean;contact_match:boolean}}|null>(null)
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');setResult(null)
 try{const r=await fetch('/api/leads/source-review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});const b=await r.json();if(!r.ok){setError(b.error||'Could not save this source review.');return}setResult(b)}catch{setError('Could not save this source review. Please try again.')}finally{setBusy(false)}}
 return <details className="mb-4 text-sm text-[#333]">
 <summary className="cursor-pointer">Review a source you found (no AI or paid enrichment)</summary>
 <form onSubmit={e=>void submit(e)} className="card p-4 mt-2 space-y-3">
 <p className="text-xs">Save one company and your claim with an exact source quote. One public HTTPS page is checked, with no model, paid renderer or enrichment. This does not verify buying intent, current need, date, ownership or consent. It lands in needs-review, not confirmed by you.</p>
 {([['company','Company',150],['signal','Your signal claim',500],['source_url','Public HTTPS source URL',500],['excerpt','Exact quote from the page (20-400 characters)',400],['contact','Email shown on that source (optional)',254],['event_date','Claimed event date, YYYY-MM-DD (optional)',10]] as const).map(([key,label,max])=><label className="block text-xs" key={key}>{label}{key==='excerpt'||key==='signal'?<textarea className="field w-full mt-1" rows={3} required maxLength={max} minLength={key==='excerpt'?20:1} value={value[key]} onChange={e=>setValue({...value,[key]:e.target.value})}/>:<input className="field w-full mt-1" required={key==='company'||key==='source_url'} maxLength={max} value={value[key]} onChange={e=>setValue({...value,[key]:e.target.value})}/>}</label>)}
 <button disabled={busy} className="font-mono text-xs uppercase border border-black px-3 py-2 disabled:opacity-40">{busy?'Checking source...':'Check source and save for review'}</button>
 {error&&<p role="alert" className="text-xs">{error}</p>}
 {result&&<div className="border-l-2 border-black pl-3 text-xs" role="status"><p>Saved for review. Page: {result.check.fetch_status}. Quote match: {result.check.quote_match?'yes':'no'}. Company named with matching quote: {result.check.company_named?'yes':'no'}. Email found: {result.check.contact_match?'yes':'no'}.</p><p>No signal meaning, event date, buying need or human confirmation was verified.</p><a className="underline" href={`/app/leads?job_id=${result.job_id}`}>Open saved source review</a></div>}
 </form></details>
}
