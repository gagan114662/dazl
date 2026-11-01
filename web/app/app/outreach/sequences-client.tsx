'use client'
import { useEffect, useState } from 'react'
import Caveat from '@/app/app/caveat'

type Step = { step: number; subject: string; body: string; status: string }
type Sequence = { currentness_held?: boolean; id: string; message_id: string; lead_id: string; to_email: string; status: string; stop_reason: string | null; evidence_state?: 'machine' | 'human' | 'unverified'; steps: Step[] }
type Analytics = { sent: number; delivered: number; replied: number; bounced: number; optOuts: number }
type Freshness = { scheduler: 'never_ran'|'running'|'fresh'|'stale'|'crashed'; state: 'healthy'|'idle'|'stale'|'blocked'|'held'; reasons: string[]; holds: string[]; work: { kind: string; last_success_at: number|null; consecutive_failures: number }[]; oldest_due: { due_at: number; overdue_s: number }|null }
const HOLD_COPY: Record<string,string> = { autopilot_off: 'autopilot is off or its consent needs renewing', followups_off: 'follow-ups are off', paused: 'sending is paused', daily_cap: 'today\'s send cap is reached', changed_since_approval: 'a step changed after approval' }
const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60)); return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago` }
type AutoPolicy = { version: string; text: string[]; accepted: boolean }
type Data = { freshness?: Freshness; gates?: {id:string;ok:boolean;scope:string}[]; scheduler?: 'configured_on'|'operator_off'|'kill_switch'|'paused'; sequences: Sequence[]; test_addresses: string[]; test_fixture_available?: boolean; auto_policy?: AutoPolicy; status: Record<string,{status:string;step:number;next_due_at:number|null}>; campaigns: { id: string; query: string; analytics: Analytics }[] }
const COPY: Record<string,string> = {
  not_sales_contact: 'The published address is for recruitment, support, privacy or another restricted purpose. Saved words remain unchanged; approval and sending are blocked.',
  reading_not_enabled:'Enable reply reading in Settings before approving a sequence. Without it, sequences cannot stop on replies.',
  sender_identity_missing:'Add your sender name and mailing address in the form at the top of this page.',
  gmail_not_connected:'Connect Gmail in Settings.',
  not_editable:'This sequence has started. Stop it instead of editing sent content.',
  already_exists:'A sequence already exists for this lead.',
  suppressed:'This address is suppressed. Nothing will be sent.',
  not_a_draft:'This sequence is no longer a draft. Refresh the page.',
  test_tenant_only:'The sequence test fixture is only available on the operator-designated test account.',
  test_inbox_not_allowlisted:'Add the test inbox to the allowlist above first.',
  lead_currentness_unconfirmed:'Event timing is unconfirmed. This set is preserved, but approval and unsent steps are held.',
  review_unreadable:'The website check could not be read just now. Nothing was sent and nothing was changed. Try again in a minute.',
  domain_unconfirmed:'The website behind this sequence is not confirmed as the right company. Confirm it on the Leads page. That check is not need or consent. If the lead shows no check there, skip this draft and create a new one from the lead.',
  lead_evidence_withdrawn:'The lead confirmation behind this sequence was withdrawn. Re-confirm the lead on the Leads page - dazl has not verified it.',
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
    <Caveat className="text-sm text-[#555] mt-2" summary="Approve a three-step sequence once and send step 1 yourself; steps 2 and 3 send automatically unless someone replies, bounces or opts out.">Create a three-step sequence from a draft above. Review and edit every word, then approve the set once. Send step 1 yourself. If there is no reply, steps 2 and 3 send automatically at 3 and 7 days after step 1. Any human reply, bounce or opt-out stops the sequence. No content is generated after approval.</Caveat>
    <p className="text-xs text-[#666] mt-2">Every step includes your sender details and unsubscribe link. One shared limit of 20 emails per account in 24 hours. Reply reading must stay connected. Scheduled sends require the sequence scheduler to be enabled by the site operator.</p>
    {data?.auto_policy&&(data.auto_policy.accepted
      ? <div className="text-xs text-[#666] mt-2" role="status" data-testid="auto-policy-status"><p>Automatic follow-up sequences are on (policy {data.auto_policy.version}). A confirmed-sent first email starts a 3-step sequence by itself; a reply, opt-out, bounce or changed details stops it. You can stop any sequence below.</p>
        <button disabled={busy} className="btn-ghost text-xs mt-2" data-testid="auto-policy-revoke" onClick={()=>void action({action:'revoke_auto_policy'})}>Turn off automatic sequences</button>
        <p className="mt-1">Turning off stops every automatic sequence at its next scheduled step and no new ones start. Sequences you approved yourself are unaffected.</p></div>
      : <div className="text-sm mt-3 border border-black/20 rounded p-3" data-testid="auto-policy-offer">
        <p className="font-medium">Automatic follow-up sequences (one-time policy)</p>
        <ul className="list-disc pl-5 text-xs text-[#555] mt-2">{data.auto_policy.text.map((t,i)=><li key={i}>{t}</li>)}</ul>
        <button disabled={busy} className="btn-ghost text-xs mt-3" onClick={()=>void action({action:'accept_auto_policy',version:data.auto_policy!.version})}>Accept policy {data.auto_policy.version} and turn on automatic sequences</button>
      </div>)}
    {data?.scheduler&&data.scheduler!=='configured_on'&&<p className="text-xs mt-2 border border-[#999] rounded p-2" role="status">{data.scheduler==='operator_off'?'Scheduled steps are switched off by the site operator right now. Approved steps 2 and 3 will not send until it is switched on.':data.scheduler==='kill_switch'?'Scheduled sending is stopped by the operator kill switch. Approved steps 2 and 3 will not send.':'Your scheduled sending is paused. Approved steps 2 and 3 will not send until you resume it.'}</p>}
    {data?.scheduler==='configured_on'&&<p className="text-xs text-[#666] mt-2" role="status">Scheduler configuration is on (operator switch, kill switch and your pause). This is not a heartbeat: it does not confirm the scheduler is running, that a step is due, or that Gmail, reply reading and the sender account are healthy.</p>}
    {data?.freshness&&(data.freshness.state==='stale'||data.freshness.state==='blocked')&&<div className="text-xs mt-2 border border-[#b45309] rounded p-2" role="alert" data-testid="scheduler-freshness"><p className="font-medium">{data.freshness.state==='blocked'?'Scheduled work is blocked.':'Scheduled work is not keeping up.'}</p><ul className="list-disc pl-5">{data.freshness.reasons.map(r=><li key={r}>{({scheduler_stale:'The scheduler has not completed a run recently.',scheduler_crashed:'The last scheduler run stopped without finishing.',scheduler_never_ran:'The scheduler has never run.',reply_sync_failing:'Reading replies has failed several times in a row.',followups_failing:'Follow-ups have failed several times in a row.',sequences_failing:'Sequence steps have failed several times in a row.',reply_sync_stale:'Replies have not been read successfully for over two hours.',due_work_overdue:'A due step is more than an hour overdue.'} as Record<string,string>)[r]??r}</li>)}</ul></div>}
    {data?.freshness&&data.freshness.state==='held'&&<p className="text-xs text-[#666] mt-2" role="status" data-testid="scheduler-freshness">Scheduled work is on hold: {data.freshness.holds.map(h=>{const [kind,reason]=h.split(':');return `${({reply_sync:'replies',followups:'follow-ups',sequences:'sequence steps'} as Record<string,string>)[kind]??kind} (${HOLD_COPY[reason]??reason})`}).join(', ')}.</p>}
    {data?.freshness&&data.freshness.state==='healthy'&&<p className="text-xs text-[#666] mt-2" role="status" data-testid="scheduler-freshness">Scheduler progress: {data.freshness.work.filter(w=>w.last_success_at).map(w=>`${({reply_sync:'replies read',followups:'follow-ups',sequences:'sequence steps'} as Record<string,string>)[w.kind]??w.kind} ${ago(w.last_success_at!)}`).join(', ')||'no work yet'}.</p>}
    {data?.gates&&data.gates.some(g=>!g.ok)&&<ul className="text-xs mt-2 list-disc pl-5" aria-label="Sending prerequisites not met">{data.gates.filter(g=>!g.ok).map(g=><li key={g.id}>{({gmail:'Gmail is not connected or needs reconnecting.',read_consent:'Reply reading is not enabled.',sender_identity:'Sender name and mailing address are missing.',uncertain_send:'A send with an unknown outcome is holding all sending on your account until it is reviewed.'} as Record<string,string>)[g.id]}</li>)}</ul>}
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
      <p className="font-medium mt-3">Reply-stop check</p>
      <p className="text-xs text-[#555] mt-1">Creates a separate two-step test set for verifying that a reply stops a live sequence before the next step. Same rules: test-only, allowlisted inbox only, nothing sends until you review the exact words and approve.</p>
      <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'create_reply_stop_fixture'})}>Create the reply-stop test fixture</button>
    </div>}
    {note&&<p role="status" className="text-sm mt-3 text-[#555]">{note}</p>}
    {data?.sequences.map(s=>{
      const state=data.status[s.lead_id]
      const label=s.status==='active'?`Step ${state?.step??1} sent / awaiting step ${(state?.step??1)+1}`:s.status
      return <article key={s.id} className="card p-4 mt-4 text-sm">
        <div className="font-medium">{s.to_email}{data?.test_addresses.map(a=>a.toLowerCase()).includes(s.to_email.toLowerCase()) ? <span className="ml-2 text-[10px] uppercase tracking-wide text-[#111] border border-[#999] px-1 py-0.5">test mode</span> : null}</div><div className="text-xs text-[#555] mt-1">{label}{s.stop_reason?` (${s.stop_reason==='evidence_withdrawn'?'lead confirmation withdrawn':s.stop_reason})`:''}{state?.next_due_at?` - due ${new Date(state.next_due_at*1000).toLocaleString()}`:''}</div>
        {s.currentness_held&&<p className="text-xs border-l-2 border-black pl-3 mt-2">Held: event timing and current need are unconfirmed. Unsent steps will not run. Sequence status and original words are preserved.</p>}
        {s.evidence_state==='human'&&['draft','approved'].includes(s.status)&&<p className="text-xs text-[#333] border-l-2 border-[#111] pl-3 mt-2">Lead confirmed by you - dazl did not verify the quote. Approving this set approves your own confirmation, not a dazl verification; withdrawing it stops unsent steps.</p>}
        {s.evidence_state==='unverified'&&['draft','approved'].includes(s.status)&&<p className="text-xs text-[#111] font-medium border-l-2 border-[#111] pl-3 mt-2">Lead confirmation withdrawn - this set cannot be approved or send further steps unless you re-confirm the lead or dazl verifies it.</p>}
        {s.steps.map(st=><div key={st.step} className="mt-4 border-t border-black/10 pt-3">
          <h3 className="font-medium">Step {st.step}{st.step>1?` - ${st.step===2?'3':'7'} days after step 1`:''} ({st.status})</h3>
          {edit?.id===s.id&&edit.step===st.step?<div className="mt-2">
            <label className="block">Subject<input className="field w-full" value={edit.subject} maxLength={150} onChange={e=>setEdit({...edit,subject:e.target.value})}/></label>
            <label className="block mt-2">Message<textarea className="field w-full" rows={6} value={edit.body} maxLength={3000} onChange={e=>setEdit({...edit,body:e.target.value})}/></label>
            <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'edit',...edit})}>Save and remove set approval</button>
          </div>:<><p className="mt-2 font-medium">{st.subject}</p><pre className="font-sans whitespace-pre-wrap text-[#333] mt-1">{st.body}</pre>{['draft','approved'].includes(s.status)&&<button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>setEdit({id:s.id,step:st.step,subject:st.subject,body:st.body})}>Edit step {st.step}</button>}</>}
          {st.status==='uncertain'&&<div className="mt-2"><p>Check Gmail Sent before resolving. The account remains paused until you explicitly resume sending below.</p><button disabled={busy} onClick={()=>void action({action:'mark_sent',id:s.id,step:st.step})}>I confirmed it was sent</button> / <button disabled={busy} onClick={()=>void action({action:'retry',id:s.id,step:st.step})}>I confirmed it was not sent</button></div>}
        </div>)}
        {!s.currentness_held&&s.evidence_state!=='unverified'&&s.status==='draft'&&<button disabled={busy||!!edit} className="btn-primary text-xs mt-4" onClick={()=>void action({action:'approve',id:s.id})}>Approve exact words of all 3 steps</button>}
        {['draft','approved','active'].includes(s.status)&&<button disabled={busy} className="btn-ghost text-xs mt-4 ml-2" onClick={()=>void action({action:'stop',id:s.id})}>Stop sequence</button>}
      </article>
    })}
    <button disabled={busy} className="btn-ghost text-xs mt-4" onClick={()=>void action({action:'resume'})}>Resume after resolving unknown sends</button>
    <h2 className="text-lg font-semibold mt-8">Campaign analytics</h2>
    <p className="text-xs text-[#555] mt-1">A campaign is a scan. "No bounce reported" is sent minus recorded permanent bounces, not confirmed delivery. Opens and bookings are not tracked.</p>
    {data?.campaigns.map(c=><div key={c.id} className="card p-3 mt-3 text-sm"><p className="font-medium">{c.query||c.id}</p><p className="text-xs text-[#555] mt-2">Sent {c.analytics.sent} / No bounce reported {c.analytics.delivered} / Replied {c.analytics.replied} / Bounced {c.analytics.bounced} / Opt-outs {c.analytics.optOuts}</p></div>)}
  </section>
}
