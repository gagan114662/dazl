'use client'
import { useEffect, useState } from 'react'
import Provenance from './provenance'
import type { OutreachProvenance } from '@/lib/outreach/provenance'
import SequencesClient from './sequences-client'
import SendReadiness from './send-readiness'

interface Msg { currentness_held?: boolean; provenance?: OutreachProvenance | null; id: string; to_email: string; subject: string; body: string; status: string; error: string | null; sent_at: number | null; test?: number; evidence_state?: 'machine' | 'human' | 'unverified' }

const ERR: Record<string, string> = {
  not_sales_contact: 'The published address is for recruitment, support, privacy or another restricted purpose. Saved words remain unchanged; approval and sending are blocked.',
  sender_identity_missing: 'Add your name and mailing address in Settings first.',
  gmail_not_connected: 'Connect Gmail in Settings first.',
  gmail_reconnect_needed: 'Gmail needs to be reconnected in Settings.',
  suppressed: 'This address unsubscribed, so it will not be emailed.',
  daily_cap: 'Daily sending limit reached. Try again tomorrow.',
  gmail_rate_limited: 'Gmail is rate limiting you. Try again later.',
  changed_since_approval: 'The message changed after approval. Approve it again.',
  lead_currentness_unconfirmed: 'Event timing is unconfirmed. This draft is preserved for inspection but cannot be approved or sent.',
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

  async function load() {
    const r = await fetch('/api/outreach')
    if (r.ok) setMsgs((await r.json()).messages)
    const seq=await fetch('/api/outreach/sequences')
    if(seq.ok) setSequenceMessages((await seq.json()).sequences.map((s:{message_id:string})=>s.message_id))
  }
  useEffect(() => { void load(); const refresh=()=>void load(); window.addEventListener('sequences-updated',refresh); return ()=>window.removeEventListener('sequences-updated',refresh) }, [])

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
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold mb-1">Outreach</h1>
      <p className="text-[#555] text-sm mb-6">Review each email, approve it, then send. Manual emails send only after your click. If you turn on autopilot, it can send first emails on its own after you approve the first sends (see its consent text below). A sequence sends its later steps only after you approve all three steps together. Every email gets your name, mailing address and an unsubscribe link added automatically.</p>
      <SendReadiness />
      {note && <p className="text-sm text-yellow-400 mb-4">{note}</p>}
      {msgs.length === 0 && <p className="text-[#666] text-sm">No emails yet. Open Leads and choose Draft email on a lead with a published address.</p>}
      <div className="flex flex-col gap-3">
        {msgs.map(m => {
          const e = edit[m.id]
          return (
            <div key={m.id} className="card p-4 text-sm">
              <div className="flex justify-between text-[#555] text-xs mb-2"><span>To {m.to_email}{m.test ? <span className="ml-2 text-[10px] uppercase tracking-wide text-yellow-300 border border-yellow-300/40 px-1 py-0.5">test mode</span> : null}</span><span>{m.status}{m.error && m.status !== 'sent' ? ` (${m.error})` : ''}</span></div>
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
      <SequencesClient />
    </div>
  )
}
