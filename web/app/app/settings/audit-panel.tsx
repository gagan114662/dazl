'use client'
import { useEffect, useState } from 'react'

// The workspace's audit trail (GET /api/workspace/audit, #371), for owners and admins: who changed a credential,
// billing, CRM, sending, pipeline or export setting, or deleted data, and when. Read-only: nothing here edits or
// removes an event. Rendered for owners and admins only (settings/page.tsx), and hidden if the route refuses anyway.
type Ev = { id: string; at: number; actor_id: string; actor_kind: string; action: string; resource_type: string; resource_id: string | null; decision: string }

const FILTERS = [['', 'Everything'], ['credential.', 'Credentials'], ['billing.', 'Billing'], ['crm.', 'CRM'], ['export.', 'Exports'],
  ['pipeline.', 'Pipeline'], ['outreach.', 'Sending'], ['sequence.', 'Sequences'], ['autopilot.', 'Autopilot'], ['followups.', 'Follow-ups'], ['monitor.', 'Monitors'],
  ['data.', 'Deletions']] as const
const LABEL: Record<string, string> = {
  'credential.saved': 'Saved a credential', 'credential.removed': 'Removed a credential', 'credential.rotated': 'Rotated a signing secret',
  'billing.checkout_started': 'Started checkout', 'billing.portal_opened': 'Opened the billing portal', 'billing.plan_changed': 'Plan changed',
  'billing.plan_held': 'Plan held for reconciliation', 'billing.payment_failed': 'Payment failed',
  'crm.pushed': 'Pushed a lead to the CRM', 'crm.resolved': 'Recorded a CRM result', 'export.leads': 'Exported leads', 'export.audit': 'Exported the audit trail',
  'pipeline.quarantined': 'Quarantined a lead', 'pipeline.released': 'Released a lead', 'pipeline.confirmed': 'Confirmed a lead', 'pipeline.unconfirmed': 'Withdrew a confirmation',
  'outreach.send': 'Sent a message', 'outreach.approve': 'Approved a message', 'outreach.skip': 'Skipped a message', 'outreach.mark_sent': 'Marked a message sent', 'outreach.retry': 'Retried a message',
  'settings.changed': 'Changed settings', 'consent.accepted': 'Accepted a channel notice', 'consent.revoked': 'Revoked a channel notice',
  'sequence.approve': 'Approved a sequence', 'sequence.stop': 'Stopped a sequence', 'sequence.resumed': 'Resumed sequences',
  'sequence.mark_sent': 'Marked a sequence step sent', 'sequence.retry': 'Retried a sequence step',
  'followups.enabled': 'Turned follow-ups on', 'followups.disabled': 'Turned follow-ups off',
  'monitor.created': 'Created a monitor', 'monitor.enabled': 'Resumed a monitor', 'monitor.disabled': 'Paused a monitor',
  'connector.enabled': 'Turned a channel on', 'connector.disabled': 'Turned a channel off', 'data.deleted': 'Deleted data', 'audit.read': 'Tried to read the audit trail',
}
const label = (a: string) => LABEL[a] ?? (a.startsWith('autopilot.') ? `Autopilot: ${a.slice(10)}` : a)
const when = (s: number) => new Date(s * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function AuditPanel() {
  const [events, setEvents] = useState<Ev[] | null>(null)
  const [filter, setFilter] = useState('')
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    void fetch(`/api/workspace/audit?limit=50${filter ? `&action=${encodeURIComponent(filter)}` : ''}`)
      .then(r => (r.ok ? r.json() : null)).then(j => { if (j) setEvents(j.events); else setHidden(true) })
      .catch(() => setHidden(true))
  }, [filter])

  if (hidden || !events) return null
  return (
    <div id="audit" className="card p-6 mb-4 scroll-mt-6">
      <h2 className="font-semibold mb-1">Audit trail</h2>
      <p className="text-[#555] text-sm mb-4">
        Who changed credentials, billing, CRM, sending and pipeline settings, exported data or deleted it, newest first. Only owners and admins
        see this. Events cannot be edited or removed, and never contain keys, secrets or message text. Kept for 400 days.
      </p>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select className="input" aria-label="Show" value={filter} onChange={e => setFilter(e.target.value)}>
          {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <a className="text-sm underline underline-offset-4" href={`/api/workspace/audit?format=csv${filter ? `&action=${encodeURIComponent(filter)}` : ''}`}>Download CSV</a>
      </div>
      {events.length === 0 ? <p className="text-sm text-[#555]">Nothing recorded yet.</p> : (
        <ul className="divide-y divide-[#eee] text-sm">
          {events.map(e => (
            <li key={e.id} className="py-2 flex flex-col gap-0.5">
              <span className={e.decision === 'denied' ? 'text-[#a00]' : ''}>{label(e.action)}{e.decision === 'denied' ? ' (refused)' : ''}</span>
              <span className="text-xs text-[#555] break-words">
                {when(e.at)} · {e.actor_kind === 'service' ? `${e.actor_id} (automatic)` : e.actor_id} · {e.resource_type}{e.resource_id ? ` ${e.resource_id}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
