// #402: the owner-facing half of the product-truth pause. GET /api/outreach/autopilot returns launch.paused_because (one
// line) and launch.reaccept_action when a launch is bound to an older product truth record; this shows that line and a
// "Re-accept current record" button that posts {action: reaccept_action}. Plain createElement so node tests can render it.
import { createElement as h } from 'react'

export interface LaunchView { accepted?: unknown; problem?: string; paused_because?: string; reaccept_action?: string }

export function reacceptBody(launch: LaunchView | undefined): { action: string } | null {
  return launch?.paused_because && launch.reaccept_action ? { action: launch.reaccept_action } : null
}

// What a failed re-accept response says, as short readable lines: preflight failures, held leads, or policy problems.
export function preflightLines(res: unknown): string[] {
  const r = (res ?? {}) as { preflight?: { failures?: unknown; heldLeads?: unknown }; problems?: unknown }
  const words = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.replace(/_/g, ' ')) : [])
  const out = [...words(r.preflight?.failures), ...words(r.problems)]
  const hl: unknown = r.preflight?.heldLeads
  const held = Array.isArray(hl) ? hl.filter((x): x is string => typeof x === 'string') : []
  if (held.length) out.push(`held leads: ${held.join(', ')}`)
  return out
}

export function LaunchPause({ launch, onReaccept, details = [], busy = false }: { launch: LaunchView | undefined; onReaccept: (body: { action: string }) => void; details?: string[]; busy?: boolean }) {
  const body = reacceptBody(launch)
  if (!body) return null
  return h('div', { 'data-launch-paused': '', className: 'text-sm space-y-2 mb-3' },
    h('p', null, launch!.paused_because),
    h('button', { type: 'button', className: 'btn-primary disabled:opacity-40', disabled: busy, onClick: () => onReaccept(body) }, 'Re-accept current record'),
    details.length > 0 ? h('ul', { className: 'list-disc pl-5 text-xs text-[#555]' }, ...details.map((d, k) => h('li', { key: k }, d))) : null)
}
