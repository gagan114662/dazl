'use client'

export type LifecycleDeletion = { state: string; requested_at: number; requested_by: string; policy: { suppressions: 'retain' | 'erase' }; retained: Record<string, number> | null; completed_at: number | null }
// What the user types to confirm a deletion: the workspace's name, or the word DELETE when it has none. The server still needs
// the exact account id (confirm_tenant); the panel sends the id it was given, so the raw id is never shown or typed.
export const confirmWord = (name: string | null | undefined): string => (name ?? '').trim() || 'DELETE'
export const confirmMatches = (name: string | null | undefined, typed: string): boolean => {
  const w = confirmWord(name), t = typed.trim()
  return w === 'DELETE' ? t.toUpperCase() === 'DELETE' : t === w
}
// The records kept after a deletion, in plain words (the stored names are database table names).
const RETAINED_LABEL: Record<string, string> = { audit_events: 'the record of account changes', evidence_purge_audit: 'the record of evidence clean-ups', onboarding_audit: 'the record of email opt-ins', suppressions: 'the opt-out list' }
export const retainedLabel = (t: string, n: number): string => `${RETAINED_LABEL[t] ?? 'other required records'} (${n})`
export const retainedSentence = (r: Record<string, number>): string => Object.entries(r).map(([t, n]) => retainedLabel(t, n)).join(', ')
export type LifecycleStatus = { tenant: string; tables: Record<string, number>; always_retained: string[]; deletion: LifecycleDeletion | null; can_delete?: boolean; deletion_available?: boolean }

export const OWNER_ONLY_DELETE_MESSAGE = 'Only a workspace owner can delete this account.'
// Same wording as the delete route's 503, so the panel and the route never disagree about why.
export const UNAVAILABLE_DELETE_MESSAGE = 'Account deletion is not available yet. Contact support to delete this account.'

// The delete and resume controls are owner-only: the delete route enforces it (denied(user, 'owners')), and the
// server sends can_delete from the member's role so the panel never shows a control that could only fail. A
// missing can_delete (a server from before this field) keeps the old behavior; the route still enforces.
// deletion_available is the same idea for service configuration: without the off-database ledger the route 503s,
// so the panel shows the unavailable note instead of an active control. A missing field (older server) keeps the
// old behavior here too.
// The export control is not gated here: export is a viewer action (web/lib/workspaces.ts), open to every role.
export function DeleteControls({ s, sup, setSup, confirm, setConfirm, onDelete, name }: {
  s: LifecycleStatus
  sup: 'retain' | 'erase'
  setSup: (v: 'retain' | 'erase') => void
  confirm: string
  setConfirm: (v: string) => void
  onDelete: () => void
  name?: string | null
}) {
  const d = s.deletion
  if (d) return (
    <div className="mt-4 text-sm">
      <p>Deletion requested {new Date(d.requested_at * 1000).toLocaleString()} - {d.state === 'completed' ? 'completed' : `at "${d.state}"`}.</p>
      {d.retained && <p className="text-xs text-[#666] mt-1">Kept after deletion: {retainedSentence(d.retained)}. The opt-out list was {d.policy.suppressions === 'retain' ? 'kept, and stays suppressed if this account is ever restored' : 'erased with everything else'}.</p>}
      {s.can_delete === false
        ? <p className="text-xs text-[#666] mt-1">{OWNER_ONLY_DELETE_MESSAGE}</p>
        : s.deletion_available === false
          ? <p className="text-xs text-[#666] mt-1">{UNAVAILABLE_DELETE_MESSAGE}</p>
          : d.state !== 'completed' && <button className="btn-primary mt-2" onClick={onDelete}>Resume deletion</button>}
    </div>
  )
  if (s.can_delete === false) return (
    <div className="mt-4 text-sm border-t border-[#e5e2dc] pt-3">
      <p className="text-xs text-[#666]">{OWNER_ONLY_DELETE_MESSAGE}</p>
    </div>
  )
  if (s.deletion_available === false) return (
    <div className="mt-4 text-sm border-t border-[#e5e2dc] pt-3">
      <p className="text-xs text-[#666]">{UNAVAILABLE_DELETE_MESSAGE}</p>
    </div>
  )
  return (
    <div className="mt-4 text-sm border-t border-[#e5e2dc] pt-3">
      <p className="font-medium">Delete this account</p>
      <p className="text-xs text-[#666] mt-1">This deletes the records this workspace holds. Kept after deletion: a few records that can never be erased (the record of account changes and of email opt-ins) - plus the opt-out list if you choose to keep it below. This cannot be undone.</p>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <label className="text-xs"><input type="radio" name="sup" checked={sup === 'retain'} onChange={() => setSup('retain')} /> Keep the opt-out list (stays suppressed if this account is ever restored)</label>
        <label className="text-xs"><input type="radio" name="sup" checked={sup === 'erase'} onChange={() => setSup('erase')} /> Erase the opt-out list too</label>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 mt-2">
        <input className="field flex-1 min-w-0 w-full" aria-label="Confirm deletion" placeholder={`Type ${confirmWord(name)} to confirm`} value={confirm} onChange={e => setConfirm(e.target.value)} />
        <button className="btn-primary" disabled={!confirmMatches(name, confirm)} onClick={onDelete}>Delete this account</button>
      </div>
    </div>
  )
}
