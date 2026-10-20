'use client'
import { useEffect, useState } from 'react'

interface Msg { id: string; to_email: string; subject: string; body: string; status: string; error: string | null; sent_at: number | null }

const ERR: Record<string, string> = {
  sender_identity_missing: 'Add your name and mailing address in Settings first.',
  gmail_not_connected: 'Connect Gmail in Settings first.',
  gmail_reconnect_needed: 'Gmail needs to be reconnected in Settings.',
  suppressed: 'This address unsubscribed, so it will not be emailed.',
  daily_cap: 'Daily sending limit reached. Try again tomorrow.',
  gmail_rate_limited: 'Gmail is rate limiting you. Try again later.',
  changed_since_approval: 'The message changed after approval. Approve it again.',
  already_sending: 'This message is already being sent.',
  already_uncertain: 'We could not confirm whether this was sent. Check your Gmail Sent folder, then choose below.',
}

export default function OutreachClient() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [edit, setEdit] = useState<Record<string, { subject: string; body: string }>>({})
  const [note, setNote] = useState('')

  async function load() {
    const r = await fetch('/api/outreach')
    if (r.ok) setMsgs((await r.json()).messages)
  }
  useEffect(() => { void load() }, [])

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
      <p className="text-[#555] text-sm mb-6">Review each email, approve it, then send. Nothing goes out without your click. Every email gets your name, mailing address and an unsubscribe link added automatically.</p>
      {note && <p className="text-sm text-yellow-400 mb-4">{note}</p>}
      {msgs.length === 0 && <p className="text-[#666] text-sm">No emails yet. Open Leads and choose Draft email on a lead with a published address.</p>}
      <div className="flex flex-col gap-3">
        {msgs.map(m => {
          const e = edit[m.id]
          return (
            <div key={m.id} className="card p-4 text-sm">
              <div className="flex justify-between text-[#555] text-xs mb-2"><span>To {m.to_email}</span><span>{m.status}{m.error && m.status !== 'sent' ? ` (${m.error})` : ''}</span></div>
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
                    {m.status === 'draft' && <button className={btn} onClick={() => act(m.id, 'approve')}>Approve</button>}
                    {m.status === 'approved' && <button className="btn-primary text-xs px-3 py-1.5" onClick={() => act(m.id, 'send')}>Send now</button>}
                    {(m.status === 'draft' || m.status === 'approved') && <button className={btn} onClick={() => act(m.id, 'skip')}>Skip</button>}
                    {m.status === 'uncertain' && <><button className={btn} onClick={() => act(m.id, 'mark_sent')}>It was sent</button><button className={btn} onClick={() => act(m.id, 'retry')}>It was not sent, allow retry</button></>}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
