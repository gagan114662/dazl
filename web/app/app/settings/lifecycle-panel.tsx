'use client'
import { useEffect, useState } from 'react'

type Deletion = { state: string; requested_at: number; requested_by: string; policy: { suppressions: 'retain' | 'erase' }; retained: Record<string, number> | null; completed_at: number | null }
type Status = { tenant: string; tables: Record<string, number>; always_retained: string[]; deletion: Deletion | null }

// Your data: what the account holds, a full export, and deleting the account. Deleting asks for the workspace id
// as confirmation and a decision on the opt-out list; the record of what was kept (retention exceptions) stays
// visible after completion. A failed deletion step resumes from the same button - nothing half-applies.
export default function LifecyclePanel() {
  const [s, setS] = useState<Status | null>(null)
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState('')
  const [sup, setSup] = useState<'retain' | 'erase'>('retain')
  useEffect(() => {
    void fetch('/api/tenant/lifecycle').then(async r => { if (r.ok) setS(await r.json()) }).catch(() => null)
  }, [])
  async function refresh() { const r = await fetch('/api/tenant/lifecycle'); if (r.ok) setS(await r.json()) }
  async function del() {
    const r = await fetch('/api/tenant/lifecycle/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm_tenant: confirm, suppressions: sup }) })
    const j = await r.json().catch(() => ({}))
    if (r.ok) { setMsg(j.state === 'completed' ? 'This account is deleted. What was kept is listed below.' : `Deletion is at "${j.state}" - it resumes automatically on the next request.`) }
    else setMsg(j.error === 'reauth_required' ? 'Confirm it is you first (top of this page).' : `${j.error || 'A step failed'}${j.state ? ` (at "${j.state}"; press again to resume)` : ''}`)
    await refresh()
  }
  if (!s) return null
  const rows = Object.entries(s.tables)
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Your data</h2>
      <p className="text-sm text-[#555]">Everything this workspace holds, in one export. Deleting removes it all except the records listed under what is kept.</p>
      {rows.length > 0 && <p className="text-xs text-[#777] mt-2">{rows.length} kinds of records, {rows.reduce((a, [, n]) => a + n, 0).toLocaleString()} rows in all.</p>}
      <div className="flex flex-wrap gap-3 mt-3 text-sm">
        <button className="btn-primary" onClick={() => { setMsg(''); void fetch('/api/tenant/lifecycle/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async r => {
          if (!r.ok) { const j = await r.json().catch(() => ({})); setMsg(j.error === 'reauth_required' ? 'Confirm it is you first (top of this page).' : j.error || 'Export failed'); return }
          const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dazl-export.json'; a.click(); URL.revokeObjectURL(a.href)
        }) }}>Download my data</button>
      </div>
      {s.deletion ? (
        <div className="mt-4 text-sm">
          <p>Deletion requested {new Date(s.deletion.requested_at * 1000).toLocaleString()} - {s.deletion.state === 'completed' ? 'completed' : `at "${s.deletion.state}"`}.</p>
          {s.deletion.retained && <p className="text-xs text-[#777] mt-1">Kept under the retention policy: {Object.entries(s.deletion.retained).map(([t, n]) => `${t} (${n})`).join(', ')}. The opt-out list was {s.deletion.policy.suppressions === 'retain' ? 'kept, so those addresses are never mailed again' : 'erased with everything else'}.</p>}
          {s.deletion.state !== 'completed' && <button className="btn-primary mt-2" onClick={() => void del()}>Resume deletion</button>}
        </div>
      ) : (
        <div className="mt-4 text-sm border-t border-[#e5e2dc] pt-3">
          <p className="font-medium">Delete this account</p>
          <p className="text-xs text-[#777] mt-1">This removes every record above. Always kept: {s.always_retained.join(', ')} (append-only audit records, no email or page content). This cannot be undone.</p>
          <p className="text-xs text-[#777] mt-1">Workspace id: <code>{s.tenant}</code></p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <label className="text-xs"><input type="radio" name="sup" checked={sup === 'retain'} onChange={() => setSup('retain')} /> Keep the opt-out list (never mail those addresses again)</label>
            <label className="text-xs"><input type="radio" name="sup" checked={sup === 'erase'} onChange={() => setSup('erase')} /> Erase the opt-out list too</label>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <input className="field flex-1 min-w-0" placeholder="Type the workspace id to confirm" value={confirm} onChange={e => setConfirm(e.target.value)} />
            <button className="btn-primary" disabled={!confirm.trim()} onClick={() => void del()}>Delete everything</button>
          </div>
        </div>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
