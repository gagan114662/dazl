'use client'
import { useEffect, useRef, useState } from 'react'

// The "Push to CRM" control for one lead (#365). One push at a time: the button is disabled while a push is on its way,
// so a double click sends one request. Every outcome keeps a way forward:
//   done         what the CRM confirmed
//   failed       nothing was created: the error and "Try again"
//   unknown      the CRM may or may not have the record: "It is in my CRM" / "It is not there" (resolve), never a retry
//   in_progress  another push of this lead is on its way: rechecked a few times (read-only status, nothing is sent),
//                then "Check again"
type View = { kind: 'idle' | 'pushing' | 'done' | 'failed' | 'unknown' | 'in_progress' | 'checking'; text?: string }
const RECHECKS = 5, RECHECK_MS = 3000
const post = async (body: unknown) => {
  const r = await fetch('/api/crm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
  return { r, j: r ? await r.json().catch(() => ({})) as Record<string, unknown> : {} }
}

export function CrmPush({ leadId }: { leadId: string }) {
  const [view, setView] = useState<View>({ kind: 'idle' })
  const busy = useRef(false)
  const rechecks = useRef(0)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const show = (v: View) => { if (alive.current) setView(v) }

  async function push() {
    if (busy.current) return
    busy.current = true; show({ kind: 'pushing' })
    try {
      const { r, j } = await post({ action: 'push', lead_id: leadId })
      if (r?.ok) return show({ kind: 'done', text: String(j.message || 'Pushed to CRM') })
      const text = typeof j.error === 'string' ? j.error : r ? 'Push failed' : 'Could not reach the server'
      if (j.outcome === 'unknown') return show({ kind: 'unknown', text })
      if (j.outcome === 'in_progress') { rechecks.current = 0; show({ kind: 'in_progress', text }); return }
      show({ kind: 'failed', text })
    } finally { busy.current = false }
  }
  // Read-only: asks where the push stands; never claims or sends.
  async function check() {
    if (busy.current) return
    busy.current = true; show({ kind: 'checking', text: view.text })
    try {
      const { r, j } = await post({ action: 'status', lead_id: leadId })
      if (!r?.ok) return show({ kind: 'in_progress', text: 'Could not check just now.' })
      if (j.state === 'done') return show({ kind: 'done', text: j.external_id ? `In your CRM (record ${String(j.external_id)})` : 'In your CRM' })
      if (j.state === 'unknown') return show({ kind: 'unknown', text: 'An earlier push of this lead has an unknown result. Check your CRM for this contact first, then record what you found.' })
      if (j.state === 'none') return show({ kind: 'idle', text: 'The earlier push did not create a record. You can push again.' })
      show({ kind: 'in_progress', text: 'Still being pushed.' })
    } finally { busy.current = false }
  }
  // a bounded recheck while another push is on its way
  useEffect(() => {
    if (view.kind !== 'in_progress' || rechecks.current >= RECHECKS) return
    const t = setTimeout(() => { rechecks.current += 1; void check() }, RECHECK_MS)
    return () => clearTimeout(t)
  }, [view])
  async function resolve(created: boolean) {
    if (busy.current) return
    busy.current = true
    try {
      const { r, j } = await post({ action: 'resolve', lead_id: leadId, created })
      if (!r?.ok) return show({ kind: 'unknown', text: typeof j.error === 'string' ? j.error : 'Could not record that' })
      show(created ? { kind: 'done', text: 'Recorded: it is in your CRM' } : { kind: 'idle', text: 'Recorded: it is not there. You can push again.' })
    } finally { busy.current = false }
  }

  const btn = 'font-mono text-xs uppercase border border-black px-2 py-1 ml-2 hover:bg-black hover:text-white disabled:opacity-50 disabled:cursor-not-allowed'
  const note = (t?: string) => t ? <span className="text-gray-500 text-xs ml-2" role="status">{t}</span> : null
  switch (view.kind) {
    case 'idle': return <span data-testid="crm-push">{note(view.text)}<button onClick={() => void push()} className={btn}>Push to CRM</button></span>
    case 'pushing': return <span data-testid="crm-push"><button disabled aria-busy="true" className={btn}>Pushing…</button></span>
    case 'done': return <span data-testid="crm-push">{note(view.text)}</span>
    case 'failed': return <span data-testid="crm-push">{note(view.text)}<button onClick={() => void push()} className={btn}>Try again</button></span>
    case 'unknown': return <span data-testid="crm-push">{note(view.text)} <button onClick={() => void resolve(true)} className="underline text-xs ml-1">It is in my CRM</button> <button onClick={() => void resolve(false)} className="underline text-xs ml-1">It is not there</button></span>
    case 'in_progress': return <span data-testid="crm-push">{note(view.text)}<button onClick={() => { rechecks.current = RECHECKS; void check() }} className={btn}>Check again</button></span>
    case 'checking': return <span data-testid="crm-push">{note(view.text)}<button disabled aria-busy="true" className={btn}>Checking…</button></span>
  }
}
