'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DeleteControls, type LifecycleStatus } from './lifecycle-delete-controls'

type Status = LifecycleStatus

// Your data: what the account holds, a full export, and deleting the account. Deleting asks for the workspace id
// as confirmation and a decision on the opt-out list; the record of what was kept (retention exceptions) stays
// visible after completion. A failed deletion step resumes from the same button - nothing half-applies.
export default function LifecyclePanel() {
  const router = useRouter()
  const doneRef = useRef<HTMLDivElement>(null)
  const [s, setS] = useState<Status | null>(null)
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState('')
  const [sup, setSup] = useState<'retain' | 'erase'>('retain')
  // The completed deletion's own response: after it the session is gone, so a refetch would 401 and the
  // pre-delete snapshot would keep the delete form on screen. Render completion from the response itself.
  const [done, setDone] = useState<{ retained: Record<string, number> | null } | null>(null)
  // Focus-managed completion: the dialog is the only live control (the session is gone), so focus starts on
  // Sign out and Tab stays inside the dialog; the settings page behind it is presentation only (aria-modal).
  useEffect(() => {
    if (!done) return
    const root = doneRef.current
    const btn = root?.querySelector('button') as HTMLElement | null
    btn?.focus()
    const trap = (e: KeyboardEvent) => { if (e.key === 'Tab' && root) { e.preventDefault(); btn?.focus() } }
    root?.addEventListener('keydown', trap)
    return () => root?.removeEventListener('keydown', trap)
  }, [done])
  useEffect(() => {
    void fetch('/api/tenant/lifecycle').then(async r => { if (r.ok) setS(await r.json()) }).catch(() => null)
  }, [])
  async function refresh() { const r = await fetch('/api/tenant/lifecycle'); if (r.ok) setS(await r.json()) }
  async function del() {
    const r = await fetch('/api/tenant/lifecycle/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm_tenant: confirm, suppressions: sup }) })
    const j = await r.json().catch(() => ({}))
    if (r.ok && j.state === 'completed') { setDone({ retained: j.retained ?? null }); return } // no refetch: the session is gone with the account
    if (r.ok) { setMsg(`Deletion is at "${j.state}" - press again to resume it.`) }
    else setMsg(j.error === 'reauth_required' ? 'Confirm it is you first (top of this page).' : `${j.error || 'A step failed'}${j.state ? ` (at "${j.state}"; press again to resume)` : ''}`)
    await refresh()
  }
  async function signOut() { await fetch('/api/auth/signout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null); router.push('/') }
  if (done) return (
    <div ref={doneRef} role="dialog" aria-modal="true" aria-label="Account deleted" className="fixed inset-0 z-50 bg-[#faf7f2] overflow-y-auto">
      <div className="max-w-xl mx-auto p-6 pt-24">
        <div className="card p-6">
      <h2 className="font-semibold mb-1">Your data</h2>
      <p className="text-sm">This account is deleted.</p>
      {done.retained && <p className="text-xs text-[#666] mt-1">Kept after deletion: {Object.entries(done.retained).map(([t, n]) => `${t} (${n})`).join(', ')}.{sup === 'retain' ? ' The opt-out list was kept, and stays suppressed if this workspace id is ever restored.' : ' The opt-out list was erased with everything else.'}</p>}
      <div className="flex flex-wrap gap-3 mt-3 text-sm">
        <button className="btn-primary" onClick={() => void signOut()}>Sign out</button>
      </div>
        </div>
      </div>
    </div>
  )
  if (!s) return null
  const rows = Object.entries(s.tables)
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Your data</h2>
      <p className="text-sm text-[#555]">An export of the data this workspace holds: sign-in records are left out, stored credentials are redacted, and internal conversion markers are generalized. Deleting removes it all except the records listed under what is kept.</p>
      {rows.length > 0 && <p className="text-xs text-[#666] mt-2">{rows.length} kinds of records, {rows.reduce((a, [, n]) => a + n, 0).toLocaleString()} rows in all.</p>}
      <div className="flex flex-wrap gap-3 mt-3 text-sm">
        <button className="btn-primary" onClick={() => { setMsg(''); void fetch('/api/tenant/lifecycle/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async r => {
          if (!r.ok) { const j = await r.json().catch(() => ({})); setMsg(j.error === 'reauth_required' ? 'Confirm it is you first (top of this page).' : j.error || 'Export failed'); return }
          const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dazl-export.json'; a.click(); URL.revokeObjectURL(a.href)
        }) }}>Download my data</button>
      </div>
      <DeleteControls s={s} sup={sup} setSup={setSup} confirm={confirm} setConfirm={setConfirm} onDelete={() => void del()} />
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
