'use client'
import {useState} from 'react'
type Res={job_id:string|null;feed_items:number;matched:number;leads:{lead_id:string;company:string;role:string}[];skipped:{company:string}[];note:string}
export default function HiringFeed(){
 const [feed,setFeed]=useState('sales-and-marketing'),[words,setWords]=useState('')
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[res,setRes]=useState<Res|null>(null)
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');setRes(null)
 try{const r=await fetch('/api/leads/hiring-feed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({feed,words})});const b=await r.json();if(!r.ok){setError(b.error||'Could not read the feed.');return}setRes(b)}catch{setError('Could not read the feed. Please try again.')}finally{setBusy(false)}}
 return <details className="mb-4 text-sm text-[#333]">
 <summary className="cursor-pointer">Companies posting roles (public job feed, no AI or paid enrichment)</summary>
 <form onSubmit={e=>void submit(e)} className="card p-4 mt-2 space-y-3">
 <p className="text-xs">Reads a public job feed and saves up to 6 companies whose posted role title contains your role words. A job posting is a hiring signal only. It does not show buying intent, fit or current need. Each company lands in needs-review, ungraded, with the posting line as the quote. Published contacts are read from each company's own site after saving, so they can appear a minute later (reload the list) and may be empty. Nothing is sent.</p>
 <label className="block text-xs">Feed<select value={feed} onChange={e=>setFeed(e.target.value)} className="block border border-black px-2 py-1 mt-1"><option value="sales-and-marketing">Sales and marketing roles</option><option value="business-and-management">Business and management roles</option><option value="customer-support">Customer support roles</option></select></label>
 <label className="block text-xs">Role words from your own search, comma separated (for example: sales development, account executive)<input value={words} onChange={e=>setWords(e.target.value)} maxLength={200} required className="block w-full border border-black px-2 py-1 mt-1"/></label>
 <button disabled={busy} className="font-mono text-xs uppercase border border-black px-3 py-2 disabled:opacity-40">{busy?'Reading feed and posting pages...':'Read feed and save for review'}</button>
 {error&&<p role="alert" className="border-l-2 border-black pl-3 text-xs">{error}</p>}
 {res&&<div className="border-l-2 border-black pl-3 text-xs" role="status"><p>{res.feed_items} postings read, {res.matched} matched your words, {res.leads.length} saved for review, {res.skipped.length} not saved because the posting page did not show the posting line.</p>{res.note&&<p>{res.note}</p>}<p>No fit, buying need or contact consent was verified. Contact reads continue in the background.</p>{res.job_id&&<a className="underline" href={`/app/leads?job_id=${res.job_id}`}>Open the saved companies</a>}</div>}
 </form></details>
}
