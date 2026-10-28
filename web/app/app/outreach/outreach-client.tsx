'use client'
import { useEffect, useState } from 'react'
import Provenance from './provenance'
import type { OutreachProvenance } from '@/lib/outreach/provenance'
import SequencesClient from './sequences-client'
import SendReadiness from './send-readiness'
import { forScan, isJobId } from '@/lib/outreach/scan-drafts'
import Caveat from '@/app/app/caveat'

interface Msg { lead_id: string; send_footer?: string | null; currentness_held?: boolean; provenance?: OutreachProvenance | null; id: string; to_email: string; subject: string; body: string; status: string; error: string | null; sent_at: number | null; test?: number; evidence_state?: 'machine' | 'human' | 'unverified' }

const ERR: Record<string, string> = {
  not_sales_contact: 'The published address is for recruitment, support, privacy or another restricted purpose. Saved words remain unchanged; approval and sending are blocked.',
  sender_identity_missing: 'Add your name and mailing address in the form at the top of this page first.',
  gmail_not_connected: 'Connect Gmail in Settings first.',
  gmail_reconnect_needed: 'Gmail needs to be reconnected in Settings.',
  suppressed: 'This address unsubscribed, so it will not be emailed.',
  daily_cap: 'Daily sending limit reached. Try again tomorrow.',
  gmail_rate_limited: 'Gmail is rate limiting you. Try again later.',
  changed_since_approval: 'The message changed after approval. Approve it again.',
  lead_currentness_unconfirmed: 'Event timing is unconfirmed. This draft is preserved for inspection but cannot be approved or sent.',
  review_unreadable: 'The website check could not be read just now. Nothing was sent and nothing was changed. Try again in a minute.',
  domain_unconfirmed: 'The website behind this draft is not confirmed as the right company. Confirm it on the Leads page ("This website is the right company"). That check is not need or consent. If the lead shows no check there, skip this draft and create a new one from the lead.',
  lead_evidence_withdrawn: 'The lead confirmation behind this draft was withdrawn. Re-confirm the lead on the Leads page - dazl has not verified it.',
  already_sending: 'This message is already being sent.',
  already_uncertain: 'We could not confirm whether this was sent. Check your Gmail Sent folder, then choose below.',
}

export default function OutreachClient() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [edit, setEdit] = useState<Record<string, { subject: string; body: string }>>({})
  const [sequenceMessages,setSequenceMessages] = useState<string[]>([])
  const [creating,setCreating] = useState(false)
  const [note, setNote] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  // ?job_id=<scan> (from "Review drafts" on Leads): only that scan's emails. The scan's leads are read from the existing
  // leads endpoint (all=1: a hidden or rejected lead's draft still belongs to the scan). If they cannot be read the filter
  // fails closed: no emails are listed (never another scan's under this scan's link), with a link to show all.
  const [scan, setScan] = useState<{ id: string; leadIds: string[] | null } | null>(null)
  // Sequences and campaign analytics cover the whole workspace, so a one-scan view never renders them (not even before
  // the scan's leads load, or after that load fails). null until the URL has been read.
  const [mode, setMode] = useState<'all' | 'scan' | null>(null)
  async function load() {
    const jobId = new URLSearchParams(window.location.search).get('job_id')
    setMode(isJobId(jobId) ? 'scan' : 'all')
    if (isJobId(jobId)) {
      const lr = await fetch(`/api/leads?job_id=${jobId}&all=1`).catch(() => null)
      const lj = lr?.ok ? await lr.json().catch(() => null) : null
      setScan({ id: jobId, leadIds: lj?.leads ? lj.leads.map((l: { id: string }) => l.id) : null })
    }
    try { const r = await fetch('/api/outreach'); if (r.ok) { setMsgs((await r.json()).messages); setLoadFailed(false) } else setLoadFailed(true) } catch { setLoadFailed(true) } finally { setLoaded(true) }
    try { const seq=await fetch('/api/outreach/sequences'); if(seq.ok) setSequenceMessages((await seq.json()).sequences.map((s:{message_id:string})=>s.message_id)) } catch { /* sequence markers are optional; the email list above still stands */ }
  }
  useEffect(() => { void load(); const refresh=()=>void load(); window.addEventListener('sequences-updated',refresh); window.addEventListener('sender-updated',refresh); return ()=>{ window.removeEventListener('sequences-updated',refresh); window.removeEventListener('sender-updated',refresh) } }, []) // eslint-disable-line react-hooks/set-state-in-effect -- every setState in load() follows an await

  async function createSequence(id:string) {
    setCreating(true);setNote('Preparing template sequence...')
    try {const r=await fetch('/api/outreach/sequences',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create',message_id:id})});const j=await r.json(); if(!r.ok) setNote(`Could not create sequence (${j.error}).`); else {await load();window.location.reload()}} catch {setNote('Could not reach the server. Refresh before retrying.')} finally {setCreating(false)}
  }

  async function polish(id: string) {
    setNote('')
    const r = await fetch('/api/outreach/polish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message_id: id }) })
    const j = await r.json()
    if (r.ok && j.rewritten) setNote(`Rewritten with your ${j.vendor === 'openai' ? 'OpenAI' : 'Anthropic'} key${j.usage?.model ? ` (${j.usage.model}${j.usage.input_tokens != null ? `, ${j.usage.input_tokens} in / ${j.usage.output_tokens} out tokens` : ''})` : ''}. Review the new text below before anything is approved.`)
    else setNote(j.note || j.error || 'The rewrite did not work - the original draft is unchanged.')
    void load()
  }

  async function act(id: string, action: string) {
    setNote('')
    const r = await fetch(`/api/outreach/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
    const j = await r.json()
    if (!r.ok) setNote(ERR[j.error] || 'That did not work')
    else if (j.result === 'uncertain') setNote('Gmail did not confirm the send. Check your Sent folder, then choose whether it went out.')
    void load()
  }
  async function save(id: string) {
    const e = edit[id]
    const r = await fetch(`/api/outreach/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) })
    if (r.ok) { setEdit(({ [id]: _, ...rest }) => rest); void load() } else setNote('Subject or message is the wrong length')
  }

  const btn = 'btn-ghost text-xs px-3 py-1.5'
  const shown = scan ? (scan.leadIds ? forScan(msgs, scan.leadIds) : []) : msgs
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold mb-1">Outreach</h1>
      <Caveat className="text-[#555] text-sm mb-6" summary="Review and approve each email, then send it; only autopilot (if you turn it on) and the later steps of a sequence you approved send without a click.">Review each email, approve it, then send. Manual emails send only after your click. If you turn on autopilot, it can send first emails on its own after you approve the first sends (its consent text is in Settings). A sequence sends its later steps only after you approve all three steps together. Every email gets your name, mailing address and an unsubscribe link added automatically.</Caveat>
      <SendReadiness />
      {note && <p className="text-sm text-[#111] border-l-2 border-[#111] pl-3 mb-4" role="status">{note}</p>}
      {!loaded && <p className="text-[#666] text-sm" role="status">Loading your emails...</p>}
      {loaded && loadFailed && <p className="text-sm text-[#111] border-l-2 border-black pl-3 mb-4" role="alert">Could not load your emails. Refresh to retry.</p>}
      {scan && <p className="text-sm border-l-2 border-black pl-3 mb-4" data-testid="scan-filter">{scan.leadIds === null
        ? <>Could not load that scan&apos;s emails. Reload to retry, or </>
        : <>Showing the {shown.length} email{shown.length === 1 ? '' : 's'} from one scan. </>}
        <a className="underline" href="/app/outreach">{scan.leadIds === null ? 'show all emails' : 'Show all emails'}</a>{scan.leadIds === null ? '.' : ''} <a className="underline" href={`/app/leads?job_id=${scan.id}`}>Back to its leads</a></p>}
      {loaded && !loadFailed && msgs.length === 0 && <p className="text-[#666] text-sm">No emails yet. Open Leads and choose Draft email on a lead with a published address.</p>}
      <div className="flex flex-col gap-3">
        {shown.map(m => {
          const e = edit[m.id]
          return (
            <div key={m.id} className="card p-4 text-sm">
              <div className="flex justify-between text-[#555] text-xs mb-2"><span>To {m.to_email}{m.test ? <span className="ml-2 text-[10px] uppercase tracking-wide text-[#111] border border-[#999] px-1 py-0.5">test mode</span> : null}</span><span>{m.status}{m.error && m.status !== 'sent' ? ` (${m.error})` : ''}</span></div>
              {m.currentness_held && ['draft','approved'].includes(m.status) && <p className="text-xs border-l-2 border-black pl-3 mb-2">Held: event timing and current need are unconfirmed. Original draft preserved, approval and sending blocked.</p>}
              {m.evidence_state === 'human' && ['draft','approved'].includes(m.status) && <p className="text-xs text-[#333] border-l-2 border-[#111] pl-3 mb-2">Lead confirmed by you - dazl did not verify the quote. Withdrawing your confirmation on the Leads page blocks approval and sending.</p>}
              {m.evidence_state === 'unverified' && ['draft','approved'].includes(m.status) && <p className="text-xs text-[#111] font-medium border-l-2 border-[#111] pl-3 mb-2">Lead confirmation withdrawn - this can no longer be approved or sent unless you re-confirm the lead or dazl verifies it.</p>}
              {['draft','approved'].includes(m.status) && <Provenance value={m.provenance} />}
              {e ? (
                <div className="flex flex-col gap-2">
                  <input className="bg-white border border-black/20 rounded px-3 py-2" value={e.subject} maxLength={150} onChange={x => setEdit({ ...edit, [m.id]: { ...e, subject: x.target.value } })} />
                  <textarea className="bg-white border border-black/20 rounded px-3 py-2" rows={9} value={e.body} maxLength={3000} onChange={x => setEdit({ ...edit, [m.id]: { ...e, body: x.target.value } })} />
                  <div className="flex gap-2"><button className={btn} onClick={() => save(m.id)}>Save</button><button className={btn} onClick={() => setEdit(({ [m.id]: _, ...rest }) => rest)}>Cancel</button></div>
                </div>
              ) : (
                <>
                  <div className="font-medium mb-1">{m.subject}</div>
                  <pre className="whitespace-pre-wrap text-[#333] font-sans mb-3">{m.body}</pre>
                  {(m.status === 'draft' || m.status === 'approved') && (m.send_footer ? <div className="mb-3"><pre className="whitespace-pre-wrap text-[#777] font-sans text-xs" aria-label="Added automatically when sent">{m.send_footer}</pre><p className="text-[11px] text-[#999] mt-1">Added when sent, from your current Settings. Edit your name or address there before sending if it is wrong.</p></div> : <p className="text-xs text-[#777] mb-3">Sending needs your name and mailing address - add them in the form at the top of this page. They are appended automatically.</p>)}
                  <div className="flex gap-2 flex-wrap">
                    {(m.status === 'draft' || m.status === 'approved') && <button className={btn} onClick={() => setEdit({ ...edit, [m.id]: { subject: m.subject, body: m.body } })}>Edit</button>}
                    {!m.currentness_held && m.evidence_state !== 'unverified' && m.status === 'draft' && !sequenceMessages.includes(m.id) && <button className={btn} onClick={() => act(m.id, 'approve')}>Approve</button>}
                    {m.status === 'draft' && <button className={btn} title="Rewrites this draft with your own AI key - your provider bills you for the call" onClick={() => void polish(m.id)}>Rewrite with AI (uses your key)</button>}
                    {!m.currentness_held && m.evidence_state !== 'unverified' && m.status === 'draft' && !sequenceMessages.includes(m.id) && <button className={btn} disabled={creating} onClick={()=>void createSequence(m.id)} title="Creates editable templates without an AI call or provider charge">Create 3-step sequence (templates)</button>}
                    {!m.currentness_held && m.evidence_state !== 'unverified' && m.status === 'approved' && <button className="btn-primary text-xs px-3 py-1.5" onClick={() => act(m.id, 'send')}>Send now</button>}
                    {(m.status === 'draft' || m.status === 'approved') && <button className={btn} onClick={() => act(m.id, 'skip')}>Skip</button>}
                    {m.status === 'uncertain' && <><button className={btn} onClick={() => act(m.id, 'mark_sent')}>It was sent</button><button className={btn} onClick={() => act(m.id, 'retry')}>It was not sent, allow retry</button></>}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
      {mode === 'all' && <SequencesClient />}
      {mode === 'scan' && <p className="text-sm text-[#555] mt-8" data-testid="sequences-hidden">Cold sequences and campaign analytics cover all your scans, so they are not shown in this one-scan view. <a className="underline text-[#111]" href="/app/outreach">See all emails and sequences</a></p>}
    </div>
  )
}
