'use client'
import {useEffect,useRef,useState} from 'react'
import Caveat from '@/app/app/caveat'
type Res={job_id:string|null;feed_items:number;matched:number;leads:{lead_id:string;company:string;role:string}[];skipped:{company:string}[];note:string}
type Row={lead_id:string;company:string;state:'reading'|'finished'|'cut_off'|'failed'|'interrupted';site:string|null;emails:number}
const LABEL=(r:Row)=>r.state==='reading'?'reading the company site...':r.state==='finished'?(r.emails>0?`published address found (${r.emails})`:r.site?'site read, no published address found':'company site not confirmed, so no contact read'):'contact read did not finish'
export default function HiringFeed(){
 const [feed,setFeed]=useState('sales-and-marketing'),[words,setWords]=useState('')
 const [last,setLast]=useState<string|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[res,setRes]=useState<Res|null>(null),[rows,setRows]=useState<Row[]>([])
 const job=res?.job_id??last,timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
 async function poll(id:string,left:number){
 try{const r=await fetch(`/api/leads/hiring-feed?job_id=${id}`);if(r.ok){const b=await r.json();setRows(b.contacts);if(left>0&&b.contacts.some((c:Row)=>c.state==='reading')){timer.current=setTimeout(()=>void poll(id,left-1),4000)}}}catch{}
 }
 useEffect(()=>{if(job)void poll(job,60);return()=>clearTimeout(timer.current)},[job])
 // After a reload, show the last check's per-company state so an unfinished read can still be retried.
 useEffect(()=>{void fetch('/api/leads/hiring-feed').then(r=>r.ok?r.json():null).then(b=>{if(b?.job_id&&b.contacts?.length)setLast(b.job_id)}).catch(()=>{})},[])
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');setRes(null);setRows([])
 try{const r=await fetch('/api/leads/hiring-feed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({feed,words})});const b=await r.json();if(!r.ok){setError(b.error||'Could not read the feed.');return}setRes(b)}catch{setError('Could not read the feed. Please try again.')}finally{setBusy(false)}}
 async function retry(){if(!job)return;setError('')
 try{const r=await fetch('/api/leads/hiring-feed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({retry_job_id:job})});if(!r.ok){const b=await r.json();setError(b.error||'Could not retry.');return}clearTimeout(timer.current);setTimeout(()=>void poll(job,60),500)}catch{setError('Could not retry. Please try again.')}}
 const unfinished=rows.some(r=>r.state==='cut_off'||r.state==='failed'||r.state==='interrupted')
 return <details className="mb-4 text-sm text-[#333]">
 <summary className="cursor-pointer">Companies posting roles (public job feed, no AI or paid enrichment)</summary>
 <form onSubmit={e=>void submit(e)} className="card p-4 mt-2 space-y-3">
 <Caveat className="text-xs" summary="Saves up to 6 companies from a public job feed to needs review; a job posting is a hiring signal only, and nothing is sent.">Reads a public job feed and saves up to 6 companies whose posted role title contains your role words. A job posting is a hiring signal only. It does not show buying intent, fit or current need. Each company lands in needs-review, ungraded, with the posting line as the quote. After saving, each company's own site is read for a published contact. A read that does not finish is marked and can be retried here. Nothing is sent.</Caveat>
 <label className="block text-xs">Feed<select value={feed} onChange={e=>setFeed(e.target.value)} className="block border border-black px-2 py-1 mt-1"><option value="sales-and-marketing">Sales and marketing roles</option><option value="business-and-management">Business and management roles</option><option value="customer-support">Customer support roles</option></select></label>
 <label className="block text-xs">Role words from your own search, comma separated (for example: sales development, account executive)<input value={words} onChange={e=>setWords(e.target.value)} maxLength={200} required className="block w-full border border-black px-2 py-1 mt-1"/></label>
 <button disabled={busy} className="font-mono text-xs uppercase border border-black px-3 py-2 disabled:opacity-40">{busy?'Reading feed and posting pages...':'Read feed and save for review'}</button>
 {error&&<p role="alert" className="border-l-2 border-black pl-3 text-xs">{error}</p>}
 {!res&&last&&rows.length>0&&<div className="border-l-2 border-black pl-3 text-xs space-y-1" role="status"><p>Your last check:</p><ul>{rows.map(r=><li key={r.lead_id}>{r.company}: {LABEL(r)}</li>)}</ul>{unfinished&&<button type="button" onClick={()=>void retry()} className="font-mono text-xs uppercase border border-black px-3 py-2">Read contacts again</button>}<a className="underline block" href={`/app/leads?job_id=${last}`}>Open the saved companies</a></div>}
 {res&&<div className="border-l-2 border-black pl-3 text-xs space-y-1" role="status"><p>{res.feed_items} postings read, {res.matched} matched your words, {res.leads.length} saved for review, {res.skipped.length} not saved because the posting page did not show the posting line.</p>{res.note&&<p>{res.note}</p>}<p>No fit, buying need or contact consent was verified.</p>
 {rows.length>0&&<ul>{rows.map(r=><li key={r.lead_id}>{r.company}: {LABEL(r)}</li>)}</ul>}
 {unfinished&&<button type="button" onClick={()=>void retry()} className="font-mono text-xs uppercase border border-black px-3 py-2">Read contacts again</button>}
 {res.job_id&&<a className="underline block" href={`/app/leads?job_id=${res.job_id}`}>Open the saved companies</a>}</div>}
 </form></details>
}
