'use client'
import { useEffect, useState } from 'react'

type Step = { step: number; subject: string; body: string; status: string }
type Sequence = { id: string; message_id: string; lead_id: string; to_email: string; status: string; stop_reason: string | null; steps: Step[] }
type Analytics = { sent: number; delivered: number; replied: number; bounced: number; optOuts: number }
type Data = { sequences: Sequence[]; test_addresses: string[]; test_fixture_available?: boolean; status: Record<string,{status:string;step:number;next_due_at:number|null}>; campaigns: { id: string; query: string; analytics: Analytics }[] }
const COPY: Record<string,string> = {
  reading_not_enabled:'Enable reply reading in Settings before approving a sequence. Without it, sequences cannot stop on replies.',
  sender_identity_missing:'Add your sender name and mailing address in Settings.',
  gmail_not_connected:'Connect Gmail in Settings.',
  not_editable:'This sequence has started. Stop it instead of editing sent content.',
  already_exists:'A sequence already exists for this lead.',
  suppressed:'This address is suppressed. Nothing will be sent.',
  not_a_draft:'This sequence is no longer a draft. Refresh the page.',
  test_tenant_only:'The sequence test fixture is only available on the operator-designated test account.',
  test_inbox_not_allowlisted:'Add the test inbox to the allowlist above first.',
}
export default function SequencesClient() {
  const [data,setData]=useState<Data|null>(null)
  const [addresses,setAddresses]=useState('')
  const [note,setNote]=useState('')
  const [busy,setBusy]=useState(false)
  const [edit,setEdit]=useState<{id:string;step:number;subject:string;body:string}|null>(null)
  async function load() {
    const r=await fetch('/api/outreach/sequences')
    if (!r.ok) throw new Error('Could not load sequences.')
    const j=await r.json() as Data;setData(j);setAddresses(j.test_addresses.join('\n'))
  }
  useEffect(()=>{void load().catch(e=>setNote(String(e.message)))},[])
  async function action(body: Record<string,unknown>) {
    setBusy(true);setNote('')
    try {
      const r=await fetch('/api/outreach/sequences',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      const j=await r.json()
      if (!r.ok) {setNote(COPY[j.error]??`Could not complete this action (${j.error ?? r.status}).`);return}
      setEdit(null);await load()
      setNote(body.action==='approve'?'All three steps approved. Send step 1 above when ready. Steps 2 and 3 then run on schedule unless a reply, bounce or opt-out stops them.': 'Saved.')
      window.dispatchEvent(new Event('sequences-updated'))
    } catch {setNote('Could not reach the server. Nothing was confirmed. Refresh before trying again.')}
    finally {setBusy(false)}
  }
  return <section className="mt-10 border-t border-black/20 pt-6">
    <h2 className="text-lg font-semibold">Cold sequences</h2>
    <p className="text-sm text-[#555] mt-2">Create a three-step sequence from a draft above. Review and edit every word, then approve the set once. Send step 1 yourself. If there is no reply, steps 2 and 3 send automatically at 3 and 7 days after step 1. Any human reply, bounce or opt-out stops the sequence. No content is generated after approval.</p>
    <p className="text-xs text-[#666] mt-2">Every step includes your sender details and unsubscribe link. One shared limit of 20 emails per account in 24 hours. Reply reading must stay connected. Scheduled sends require the sequence scheduler to be enabled by the site operator.</p>
    <button disabled={busy} className="btn-ghost text-xs mt-3" onClick={()=>void load().catch(()=>setNote('Could not refresh.'))}>Refresh sequence status</button>
    <details className="mt-4 text-sm"><summary>Test inbox allowlist</summary>
      <p className="text-xs text-[#555] mt-2">Enter only your own test inboxes. Listed addresses use 3-minute and 7-minute delays. Every other address always uses 3-day and 7-day delays. Removing an address restores normal delays. No email is sent by saving this list.</p>
      <label className="block mt-2">Your test email addresses, one per line<textarea className="field w-full mt-1" rows={3} value={addresses} onChange={e=>setAddresses(e.target.value)}/></label>
      <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'test_addresses',addresses:addresses.split(/\s+/).filter(Boolean)})}>Save test inbox list</button>
    </details>
    {data?.test_fixture_available&&<div className="mt-4 text-sm border border-yellow-300/40 rounded p-3">
      <p className="font-medium">Own-inbox sequence test</p>
      <p className="text-xs text-[#555] mt-1">Creates the approved three-step verification set addressed only to your allowlisted test inbox. It is labelled test-only, is not a real prospect, and nothing sends until you review the exact words and approve the set here.</p>
      <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'create_test_fixture'})}>Create the test-only sequence fixture</button>
    </div>}
    {note&&<p role="status" className="text-sm mt-3 text-[#555]">{note}</p>}
    {data?.sequences.map(s=>{
      const state=data.status[s.lead_id]
      const label=s.status==='active'?`Step ${state?.step??1} sent / awaiting step ${(state?.step??1)+1}`:s.status
      return <article key={s.id} className="card p-4 mt-4 text-sm">
        <div className="font-medium">{s.to_email}{data?.test_addresses.map(a=>a.toLowerCase()).includes(s.to_email.toLowerCase()) ? <span className="ml-2 text-[10px] uppercase tracking-wide text-yellow-300 border border-yellow-300/40 px-1 py-0.5">test mode</span> : null}</div><div className="text-xs text-[#555] mt-1">{label}{s.stop_reason?` (${s.stop_reason})`:''}{state?.next_due_at?` - due ${new Date(state.next_due_at*1000).toLocaleString()}`:''}</div>
        {s.steps.map(st=><div key={st.step} className="mt-4 border-t border-black/10 pt-3">
          <h3 className="font-medium">Step {st.step}{st.step>1?` - ${st.step===2?'3':'7'} days after step 1`:''} ({st.status})</h3>
          {edit?.id===s.id&&edit.step===st.step?<div className="mt-2">
            <label className="block">Subject<input className="field w-full" value={edit.subject} maxLength={150} onChange={e=>setEdit({...edit,subject:e.target.value})}/></label>
            <label className="block mt-2">Message<textarea className="field w-full" rows={6} value={edit.body} maxLength={3000} onChange={e=>setEdit({...edit,body:e.target.value})}/></label>
            <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'edit',...edit})}>Save and remove set approval</button>
          </div>:<><p className="mt-2 font-medium">{st.subject}</p><pre className="font-sans whitespace-pre-wrap text-[#333] mt-1">{st.body}</pre>{['draft','approved'].includes(s.status)&&<button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>setEdit({id:s.id,step:st.step,subject:st.subject,body:st.body})}>Edit step {st.step}</button>}</>}
          {st.status==='uncertain'&&<div className="mt-2"><p>Check Gmail Sent before resolving. The account remains paused until you explicitly resume sending below.</p><button disabled={busy} onClick={()=>void action({action:'mark_sent',id:s.id,step:st.step})}>I confirmed it was sent</button> / <button disabled={busy} onClick={()=>void action({action:'retry',id:s.id,step:st.step})}>I confirmed it was not sent</button></div>}
        </div>)}
        {s.status==='draft'&&<button disabled={busy||!!edit} className="btn-primary text-xs mt-4" onClick={()=>void action({action:'approve',id:s.id})}>Approve exact words of all 3 steps</button>}
        {['draft','approved','active'].includes(s.status)&&<button disabled={busy} className="btn-ghost text-xs mt-4 ml-2" onClick={()=>void action({action:'stop',id:s.id})}>Stop sequence</button>}
      </article>
    })}
    <button disabled={busy} className="btn-ghost text-xs mt-4" onClick={()=>void action({action:'resume'})}>Resume after resolving unknown sends</button>
    <h2 className="text-lg font-semibold mt-8">Campaign analytics</h2>
    <p className="text-xs text-[#555] mt-1">A campaign is a scan. "No bounce reported" is sent minus recorded permanent bounces, not confirmed delivery. Opens and bookings are not tracked.</p>
    {data?.campaigns.map(c=><div key={c.id} className="card p-3 mt-3 text-sm"><p className="font-medium">{c.query||c.id}</p><p className="text-xs text-[#555] mt-2">Sent {c.analytics.sent} / No bounce reported {c.analytics.delivered} / Replied {c.analytics.replied} / Bounced {c.analytics.bounced} / Opt-outs {c.analytics.optOuts}</p></div>)}
  </section>
}
