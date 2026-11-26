'use client'
import { useEffect, useState } from 'react'
import Caveat from '@/app/app/caveat'
import { holdCopy, kindCopy, reasonCopy } from '@/lib/ops/scheduler-copy'
import { sequenceGmailWaitLabel } from '@/lib/gmail/notice'

type Step = { step: number; subject: string; body: string; status: string }
type Sequence = { currentness_held?: boolean; id: string; message_id: string; lead_id: string; to_email: string; status: string; stop_reason: string | null; evidence_state?: 'machine' | 'human' | 'unverified'; steps: Step[] }
type Analytics = { sent: number; delivered: number; replied: number; bounced: number; optOuts: number }
type Freshness = { scheduler: 'never_ran'|'running'|'fresh'|'stale'|'crashed'; state: 'healthy'|'idle'|'stale'|'blocked'|'held'; reasons: string[]; holds: string[]; work: { kind: string; last_success_at: number|null; consecutive_failures: number }[]; oldest_due: { due_at: number; overdue_s: number }|null }
const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60)); return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago` }
type AutoPolicy = { version: string; text: string[]; accepted: boolean; available?: boolean }
type Data = { freshness?: Freshness; gates?: {id:string;ok:boolean;scope:string}[]; scheduler?: 'configured_on'|'operator_off'|'kill_switch'|'paused'; sequences: Sequence[]; test_addresses: string[]; fixture_available?: boolean; fixture_eligible?: boolean; auto_policy?: AutoPolicy; status: Record<string,{status:string;step:number;next_due_at:number|null;stop_reason:string|null}>; campaigns: { id: string; query: string; analytics: Analytics }[] }
// #1679: a new Gmail connection is send-only (#1603), so dazl cannot see replies and a sequence could never stop on one. The page said
// that reply reading had to stay connected and to enable it in Settings, which no new account can do. One sentence, the same everywhere.
const SEQUENCES_NEED_READING = 'Follow-up sequences are not available for your account: dazl connects to Gmail send-only and does not read replies, and a sequence has to stop when someone replies. Nothing is sent automatically. You can still approve and send each email yourself.'
const COPY: Record<string,string> = {
  not_sales_contact: 'The published address is for recruitment, support, privacy or another restricted purpose. Saved words remain unchanged; approval and sending are blocked.',
  reading_not_enabled: SEQUENCES_NEED_READING,
  sender_identity_missing:'Add your sender name and mailing address in the form at the top of this page.',
  gmail_not_connected:'Connect Gmail in Settings.',
  uncertain_send:'A send with an unknown outcome is holding all sending on your account until it is reviewed. Check Gmail Sent and mark it sent or not sent above, then resume sending.',
  not_editable:'This sequence has started. Stop it instead of editing sent content.',
  already_exists:'A sequence already exists for this lead.',
  suppressed:'This address is suppressed. Nothing will be sent.',
  not_a_draft:'This sequence is no longer a draft. Refresh the page.',
  test_tenant_only:'The sequence test fixture is only available on the designated test account.',
  test_inbox_not_allowlisted:'Add the test inbox to your test list first.',
  lead_currentness_unconfirmed:'Event timing is unconfirmed. This set is preserved, but approval and unsent steps are held.',
  recipient_provenance_missing: 'Nothing was sent. This saved message cannot be retried. A mailbox check alone is not enough. For future outreach, choose a different eligible lead with a named work email published on the company’s own website.',
  review_unreadable:'The website check could not be read just now. Nothing was sent and nothing was changed. Try again in a minute.',
  domain_unconfirmed:'The website behind this sequence is not confirmed as the right company. Confirm it on the Leads page. That check is not need or consent. If the lead shows no check there, skip this draft and create a new one from the lead.',
  lead_evidence_withdrawn:'The lead confirmation behind this sequence was withdrawn. Re-confirm the lead on the Leads page - dazl has not verified it.',
}
export default function SequencesClient() {
  const [data,setData]=useState<Data|null>(null)
  const [fixtureEligible,setFixtureEligible]=useState(false)
  const [gmailStatus,setGmailStatus]=useState<string|null>(null)
  const [addresses,setAddresses]=useState('')
  const [note,setNote]=useState('')
  const [busy,setBusy]=useState(false)
  const [edit,setEdit]=useState<{id:string;step:number;subject:string;body:string}|null>(null)
  async function load() {
    const r=await fetch('/api/outreach/sequences')
    if (!r.ok) throw new Error('Could not load sequences.')
    const j=await r.json() as Data;setData(j);setAddresses(j.test_addresses.join('\n'))
    // Fixture eligibility arrives in the sequences response itself (server-checked): the page
    // never calls the staging-only fixture route just to ask whether it exists.
    setFixtureEligible(j.fixture_eligible === true)
    // #1804: the wait label needs the account's real gmail status - the gate alone cannot tell a
    // dead connection ('reconnect') from one that was never connected ('connect').
    try { const sr=await fetch('/api/outreach/settings'); if (sr.ok) { const sj=await sr.json() as { gmail?: { status?: string } | null }; setGmailStatus(sj.gmail?.status ?? null) } } catch { /* the gate label still shows */ }
  }
  useEffect(()=>{void Promise.resolve().then(load).catch(e=>setNote(String(e.message)))},[])
  async function action(body: Record<string,unknown>, target = '/api/outreach/sequences') {
    setBusy(true);setNote('')
    try {
      const r=await fetch(target,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      const j=await r.json()
      if (!r.ok) {setNote(COPY[j.error]??(j.code==='autopilot_unavailable'?String(j.error):`Could not complete this action (${j.error ?? r.status}).`));return}
      setEdit(null);await load()
      setNote(body.action==='approve'?'All three steps approved. Send step 1 above when ready. Steps 2 and 3 then run on schedule unless a reply, bounce or opt-out stops them.': 'Saved.')
      window.dispatchEvent(new Event('sequences-updated'))
    } catch {setNote('Could not reach the server. Nothing was confirmed. Refresh before trying again.')}
    finally {setBusy(false)}
  }
  return <section className="mt-10 border-t border-black/20 pt-6">
    <h2 className="text-lg font-semibold">Cold sequences</h2>
    <Caveat className="text-sm text-[#555] mt-2" summary="For a sequence you create here, you approve every word of all three steps before anything sends. Automatic sequences you turned on below start by themselves instead. Both stop on any reply, bounce or opt-out.">Create a three-step sequence from a draft above. Review and edit every word, then approve the set once. Nothing in a sequence you create sends before that approval. Send step 1 yourself. If there is no reply, steps 2 and 3 send at 3 and 7 days after step 1, exactly as approved, and no content is generated after approval. Automatic sequences are the exception: if you accepted the automatic-sequences policy below, a first email you already sent starts a sequence by itself, without this review. That path is described in the policy, and you can turn it off there. Any human reply, bounce or opt-out stops either kind of sequence.</Caveat>
    <p className="text-xs text-[#666] mt-2">Every step includes your sender details and unsubscribe link. One shared limit of 20 emails per account per day, resetting at midnight your time. A sequence runs only where dazl can read replies, so it can stop on one.</p>
    {data?.gates?.some(g=>g.id==='read_consent'&&!g.ok)&&<p className="text-sm mt-3 border border-black/20 rounded p-3" role="status" data-testid="sequences-need-reading">{SEQUENCES_NEED_READING}</p>}
    {/* #1620: the automatic-sequences policy is offered only where autopilot is available; the server sends none otherwise. */}
    {data?.auto_policy&&data.auto_policy.available===false&&data.auto_policy.accepted&&<div className="text-xs text-[#666] mt-2" role="status" data-testid="auto-policy-unavailable"><p>Sequences that start by themselves are not available during the beta, so the setting you accepted earlier is not running.</p>
      <button disabled={busy} className="btn-ghost text-xs mt-2" data-testid="auto-policy-revoke" onClick={()=>void action({action:'revoke_auto_policy'})}>Clear that setting</button></div>}
    {data?.auto_policy&&data.auto_policy.available!==false&&(data.auto_policy.accepted
      ? <div className="text-xs text-[#666] mt-2" role="status" data-testid="auto-policy-status"><p>Automatic follow-up sequences are on (policy {data.auto_policy.version}). A confirmed-sent first email starts a 3-step sequence by itself; a reply, opt-out, bounce or changed details stops it. You can stop any sequence below.</p>
        <button disabled={busy} className="btn-ghost text-xs mt-2" data-testid="auto-policy-revoke" onClick={()=>void action({action:'revoke_auto_policy'})}>Turn off automatic sequences</button>
        <p className="mt-1">Turning off stops every automatic sequence at its next scheduled step and no new ones start. A step already handed to Gmail at that moment cannot be recalled. Sequences you approved yourself are unaffected.</p></div>
      : <div className="text-sm mt-3 border border-black/20 rounded p-3" data-testid="auto-policy-offer">
        <p className="font-medium">Automatic follow-up sequences (one-time policy)</p>
        <ul className="list-disc pl-5 text-xs text-[#555] mt-2">{data.auto_policy.text.map((t,i)=><li key={i}>{t}</li>)}</ul>
        <button disabled={busy} className="btn-ghost text-xs mt-3" onClick={()=>void action({action:'accept_auto_policy',version:data.auto_policy!.version})}>Accept policy {data.auto_policy.version} and turn on automatic sequences</button>
      </div>)}
    {data?.scheduler&&data.scheduler!=='configured_on'&&<p className="text-xs mt-2 border border-[#999] rounded p-2" role="status">{data.scheduler==='paused'?'Your scheduled sending is paused. Approved steps 2 and 3 will not send until you resume it.':'Scheduled sending is paused right now. Approved steps 2 and 3 will not send until it resumes.'}</p>}
    {data?.scheduler==='configured_on'&&data.sequences.some(s=>s.status==='approved'||s.status==='active')&&<p className="text-xs text-[#666] mt-2" role="status">Scheduled sending is switched on. That alone does not confirm the scheduler is running, that a step is due, or that Gmail, reply reading and the sender account are healthy.</p>}
    {data?.freshness&&(data.freshness.state==='stale'||data.freshness.state==='blocked')&&<div className="text-xs mt-2 border border-[#b45309] rounded p-2" role="alert" data-testid="scheduler-freshness"><p className="font-medium">{data.freshness.state==='blocked'?'Scheduled work is blocked.':'Scheduled work is not keeping up.'}</p><ul className="list-disc pl-5">{data.freshness.reasons.map(r=><li key={r}>{reasonCopy(r)}</li>)}</ul></div>}
    {data?.freshness&&data.freshness.state==='held'&&<p className="text-xs text-[#666] mt-2" role="status" data-testid="scheduler-freshness">Scheduled work is on hold: {data.freshness.holds.map(h=>{const [kind,reason]=h.split(':');return `${kindCopy(kind)} (${holdCopy(reason??'unknown')})`}).join(', ')}.</p>}
    {data?.freshness&&data.freshness.state==='healthy'&&<p className="text-xs text-[#666] mt-2" role="status" data-testid="scheduler-freshness">Scheduler progress: {data.freshness.work.filter(w=>w.last_success_at).map(w=>`${w.kind==='reply_sync'?'replies read':kindCopy(w.kind)} ${ago(w.last_success_at!)}`).join(', ')||'no work yet'}.</p>}
    {data?.gates?.some(g=>g.id==='gmail'&&!g.ok)&&<p className="text-xs mt-2 text-[#555]">Follow-ups send on their own once Gmail is reconnected. You don&apos;t need to press Send for them.</p>}
    {data?.gates&&data.gates.some(g=>!g.ok)&&<ul className="text-xs mt-2 list-disc pl-5" aria-label="Sending prerequisites not met">{data.gates.filter(g=>!g.ok).map(g=><li key={g.id}>{({gmail:'Gmail is not connected or needs reconnecting.',read_consent:'Reply reading is off: dazl connects to Gmail send-only.',sender_identity:'Sender name and mailing address are missing.',uncertain_send:'A send with an unknown outcome is holding all sending on your account until it is reviewed.'} as Record<string,string>)[g.id]}</li>)}</ul>}
    <button disabled={busy} className="btn-ghost text-xs mt-3" onClick={()=>void load().catch(()=>setNote('Could not refresh.'))}>Refresh sequence status</button>
    {fixtureEligible&&<details className="mt-4 text-sm"><summary>Test inbox allowlist</summary>
      <p className="text-xs text-[#555] mt-2">Enter only your own test inboxes. Listed addresses use 3-minute and 7-minute delays. Every other address always uses 3-day and 7-day delays. Removing an address restores normal delays. No email is sent by saving this list.</p>
      <label className="block mt-2">Your test email addresses, one per line<textarea className="field w-full mt-1" rows={3} value={addresses} onChange={e=>setAddresses(e.target.value)}/></label>
      <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'test_addresses',addresses:addresses.split(/\s+/).filter(Boolean)})}>Save test inbox list</button>
    </details>}
    {fixtureEligible&&data&&data.test_addresses.length>0&&<div className="mt-4 text-sm border border-black/20 rounded p-3" role="status" data-testid="test-addresses-saved">
      <p>You have {data.test_addresses.length} saved test {data.test_addresses.length===1?'inbox':'inboxes'}. Emails to those addresses get follow-ups after minutes instead of days.</p>
      <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'test_addresses',addresses:[]})}>Remove all test inboxes</button>
    </div>}
    {process.env.NEXT_PUBLIC_DAZL_STAGING==='1'&&fixtureEligible&&<div className="mt-4 text-sm border border-yellow-300/40 rounded p-3">
      <p className="font-medium">Own-inbox sequence test</p>
      <p className="text-xs text-[#555] mt-1">Creates the approved three-step verification set addressed only to your allowlisted test inbox. It is labelled test-only, is not a real prospect, and nothing sends until you review the exact words and approve the set here.</p>
      <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'create_test_fixture'}, '/api/outreach/sequences/fixture')}>Create the test-only sequence fixture</button>
      <p className="font-medium mt-3">Reply-stop check</p>
      <p className="text-xs text-[#555] mt-1">Creates a separate two-step test set for verifying that a reply stops a live sequence before the next step. Same rules: test-only, allowlisted inbox only, nothing sends until you review the exact words and approve.</p>
      <button disabled={busy} className="btn-ghost text-xs mt-2" onClick={()=>void action({action:'create_reply_stop_fixture'}, '/api/outreach/sequences/fixture')}>Create the reply-stop test fixture</button>
    </div>}
    {note&&<p role="status" className="text-sm mt-3 text-[#555]">{note}</p>}
    {data?.sequences.map(s=>{
      const state=data.status[s.lead_id]
      const gmailDown=!!data.gates?.some(g=>g.id==='gmail'&&!g.ok)
      const waitLabel=gmailDown&&(s.status==='active'||s.status==='approved')?sequenceGmailWaitLabel(gmailStatus):null
      const label=waitLabel??(s.status==='active'?`Step ${state?.step??1} sent / awaiting step ${(state?.step??1)+1}`:s.status)
      const reason=state?.stop_reason??s.stop_reason
      return <article key={s.id} className="card p-4 mt-4 text-sm">
        <div className="font-medium">{s.to_email}{data?.test_addresses.map(a=>a.toLowerCase()).includes(s.to_email.toLowerCase()) ? <span className="ml-2 text-[10px] uppercase tracking-wide text-[#111] border border-[#999] px-1 py-0.5">test mode</span> : null}</div><div className="text-xs text-[#555] mt-1">{label}{reason?` (${reason==='evidence_withdrawn'?'lead confirmation withdrawn':reason==='policy_stop'?'stopped by policy':reason})`:''}{state?.next_due_at?` - due ${new Date(state.next_due_at*1000).toLocaleString()}`:''}</div>
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
    {(data?.sequences ?? []).some(s => s.steps.some(st => st.status === 'uncertain')) && <p className="text-xs text-[#555] mt-4">Sending stays paused while the outcome of a send is unknown. Check Gmail Sent and mark each unknown send above as sent or not sent; Resume sending works once all of them are resolved.</p>}
    <button disabled={busy} className="btn-ghost text-xs mt-4" onClick={()=>void action({action:'resume'})}>Resume sending</button>
    <h2 className="text-lg font-semibold mt-8">Campaign analytics</h2>
    <p className="text-xs text-[#555] mt-1">A campaign is a scan. &quot;No bounce reported&quot; is sent minus recorded permanent bounces, not confirmed delivery. Opens and bookings are not tracked.</p>
    {data?.campaigns.map(c=><div key={c.id} className="card p-3 mt-3 text-sm"><p className="font-medium">{c.query||c.id}</p><p className="text-xs text-[#555] mt-2">Sent {c.analytics.sent} / No bounce reported {c.analytics.delivered} / Replied {c.analytics.replied} / Bounced {c.analytics.bounced} / Opt-outs {c.analytics.optOuts}</p></div>)}
  </section>
}
