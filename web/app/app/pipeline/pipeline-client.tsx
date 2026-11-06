'use client'
import { useCallback, useEffect, useState } from 'react'
import { parseAmountInput } from '@/lib/pipeline/amount'

// Revenue pipeline (#366): this workspace's deals (one per qualified conversation), their owner and stage, the routing
// rules that assign new ones, and the report rebuilt from the deal history. Every change goes through the API, which
// checks the member's role and records the change in the audit trail.
const STAGES = ['new', 'qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost'] as const
const OPEN = ['new', 'qualified', 'meeting', 'proposal', 'negotiation']
const WON_REASONS = ['fit', 'price', 'timing', 'relationship', 'other']
const LOST_REASONS = ['price', 'competitor', 'no_budget', 'no_decision', 'timing', 'fit', 'unresponsive', 'other']
const ROUTE: Record<string, string> = { rule: 'routed by rule', no_matching_rule: 'no rule matched', owner_not_member: "the rule's owner can no longer own deals" }
const ERR: Record<string, string> = {
  conflict: 'Someone changed this deal meanwhile. Reload and try again.', reason_required: 'Pick a reason to close the deal.', amount_required: 'A won deal needs an amount and currency.',
  bad_transition: 'A closed deal changes only by reopening it to an open stage.', bad_amount: 'The amount must be a whole number of cents (0 or more), with a currency.',
  bad_currency: 'The currency must be a 3-letter code such as USD.', owner_not_member: 'That person cannot own deals in this workspace.', forbidden: 'Your role in this workspace does not allow this.',
  no_change: 'Nothing changed.', too_many_rules: 'This workspace has the maximum number of active rules.',
}

interface Deal { id: string; title: string; stage: string; owner_id: string | null; owner_label: string | null; owner_is_member: boolean; amount_minor: number | null; currency: string | null; close_reason: string | null; route_reason: string; sla_due_at: number | null; sla_overdue: boolean; created_at: number; version: number }
interface Owner { id: string; label: string; role: string }
interface Rule { id: string; position: number; match_kind: string; match_value: string; owner_id: string; sla_hours: number | null; active: number }
interface Report { deals: number; by_stage: { stage: string; deals: number }[]; won: { deals: number; amounts: Record<string, number> }; lost: { deals: number }; open: { deals: number; unassigned: number; amounts: Record<string, number>; without_amount: number }; sla_overdue: number; reconciliation: { mismatched: number | null }; definitions: Record<string, string> }

const money = (m: Record<string, number>) => Object.entries(m).map(([c, v]) => `${(v / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`).join(' + ') || '0'
const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

async function send(url: string, method: string, body: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (r.ok) return null
    const j = await r.json().catch(() => ({}))
    return ERR[j.error] ?? `The change was refused (${j.error ?? r.status}).`
  } catch { return 'Could not reach the server. Reload before trying again.' }
}

function DealRow({ d, owners, onDone }: { d: Deal; owners: Owner[]; onDone: (msg: string | null) => void }) {
  const [stage, setStage] = useState(d.stage)
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState(d.amount_minor === null ? '' : String(d.amount_minor / 100))
  const [currency, setCurrency] = useState(d.currency ?? 'USD')
  const closing = stage === 'won' || stage === 'lost'
  async function save() {
    const body: Record<string, unknown> = { version: d.version }
    if (stage !== d.stage) body.stage = stage
    if (closing && stage !== d.stage) body.close_reason = reason || null
    const cents = parseAmountInput(amount)
    if (cents === 'invalid') { onDone('The amount must be a number, like 1200 or 1200.50.'); return }
    if (OPEN.includes(d.stage) && (cents !== d.amount_minor || (cents !== null && currency !== d.currency))) { body.amount_minor = cents; body.currency = cents === null ? null : currency }
    onDone(await send(`/api/pipeline/deals/${d.id}`, 'PATCH', body))
  }
  return (
    <li className="p-4 text-sm flex flex-col gap-2" data-testid="deal-row">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-semibold [overflow-wrap:anywhere]">{d.title}</span>
        <span className="text-xs text-[#555]">{d.stage}{d.close_reason ? ` (${d.close_reason})` : ''} · {d.owner_label ?? (d.owner_id ? 'former member' : 'unassigned')} · {ROUTE[d.route_reason] ?? d.route_reason} · {day(d.created_at)}</span>
        {d.amount_minor !== null && <span className="text-xs">{money({ [d.currency ?? '?']: d.amount_minor })}</span>}
        {d.sla_overdue && <span className="text-xs text-red-700">first response overdue</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Stage" value={stage} onChange={e => setStage(e.target.value)} className="border rounded px-2 py-1">{STAGES.map(s => <option key={s}>{s}</option>)}</select>
        {closing && stage !== d.stage && (
          <select aria-label="Reason" value={reason} onChange={e => setReason(e.target.value)} className="border rounded px-2 py-1">
            <option value="">reason...</option>{(stage === 'won' ? WON_REASONS : LOST_REASONS).map(r => <option key={r}>{r}</option>)}
          </select>
        )}
        {OPEN.includes(d.stage) && <>
          <input aria-label="Amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="amount" className="border rounded px-2 py-1 w-28" />
          <input aria-label="Currency" value={currency} onChange={e => setCurrency(e.target.value.toUpperCase().slice(0, 3))} className="border rounded px-2 py-1 w-16" />
          <select aria-label="Owner" value={d.owner_id ?? ''} onChange={async e => onDone(await send(`/api/pipeline/deals/${d.id}`, 'PATCH', { version: d.version, owner_id: e.target.value || null }))} className="border rounded px-2 py-1">
            <option value="">unassigned</option>{owners.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            {d.owner_id && !d.owner_is_member && <option value={d.owner_id}>former member</option>}
          </select>
        </>}
        <button onClick={save} className="px-3 py-1 rounded-lg bg-[var(--ink)] text-white">Save</button>
      </div>
    </li>
  )
}

export default function PipelineClient() {
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [owners, setOwners] = useState<Owner[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [msg, setMsg] = useState('')
  const [rule, setRule] = useState({ match_kind: 'any', match_value: '', owner_id: '', sla_hours: '' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    Promise.all([fetch('/api/pipeline/deals'), fetch('/api/pipeline/rules'), fetch('/api/pipeline/report')])
      .then(async ([d, r, p]) => {
        if (!d.ok || !r.ok || !p.ok) throw new Error('load')
        const [dj, rj, pj] = await Promise.all([d.json(), r.json(), p.json()])
        if (!live) return
        setDeals(dj.deals); setOwners(dj.owners); setRules(rj.rules); setReport(pj)
      })
      .catch(() => { if (live) setMsg('Could not load the pipeline. Reload the page.') })
    return () => { live = false }
  }, [tick])
  const load = useCallback(() => setTick(t => t + 1), [])
  const done = (m: string | null) => { setMsg(m ?? ''); void load() }
  async function addRule() {
    done(await send('/api/pipeline/rules', 'POST', { action: 'add', match_kind: rule.match_kind, match_value: rule.match_value, owner_id: rule.owner_id, sla_hours: rule.sla_hours ? Number(rule.sla_hours) : null }))
  }
  const active = rules.filter(r => r.active === 1)
  const label = (id: string) => owners.find(o => o.id === id)?.label ?? 'former member'
  return (
    <div className="@container max-w-4xl flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Pipeline</h1>
        <p className="text-sm text-[#555]">One deal per interested conversation, routed to an owner by your rules. Reasons and every stage change are kept.</p>
      </div>
      {msg && <p role="status" className="text-sm text-red-700">{msg}</p>}
      {report && (
        <section aria-label="Report" className="grid grid-cols-2 @xl:grid-cols-4 gap-3 text-sm" data-testid="pipeline-report">
          <div className="rounded-xl border p-3"><p className="text-xs text-[#555]">Open deals</p><p className="font-semibold">{report.open.deals}</p><p className="text-xs">{money(report.open.amounts)}{report.open.without_amount ? `, ${report.open.without_amount} without amount` : ''}</p></div>
          <div className="rounded-xl border p-3"><p className="text-xs text-[#555]">Won</p><p className="font-semibold">{report.won.deals}</p><p className="text-xs">{money(report.won.amounts)}</p></div>
          <div className="rounded-xl border p-3"><p className="text-xs text-[#555]">Lost</p><p className="font-semibold">{report.lost.deals}</p></div>
          <div className="rounded-xl border p-3"><p className="text-xs text-[#555]">Needs attention</p><p className="font-semibold">{report.open.unassigned} unassigned</p><p className="text-xs">{report.sla_overdue} past first-response SLA</p></div>
          <p className="col-span-full text-xs text-[#555]">{report.definitions.attribution}. {report.definitions.amounts}.{report.reconciliation.mismatched ? ` Warning: ${report.reconciliation.mismatched} deal(s) do not match their history.` : ''}</p>
        </section>
      )}
      <section aria-label="Deals">
        <h2 className="font-semibold mb-2">Deals</h2>
        {deals === null ? <p className="text-sm">Loading...</p> : deals.length === 0
          ? <p className="text-sm text-[#555]">No deals yet. {active.length === 0 ? 'Add a routing rule below: interested replies then become deals automatically.' : 'Deals appear when a lead replies with interest.'}</p>
          : <ul className="border rounded-xl divide-y">{deals.map(d => <DealRow key={`${d.id}:${d.version}`} d={d} owners={owners} onDone={done} />)}</ul>}
        {active.length > 0 && <button onClick={async () => done(await send('/api/pipeline/deals', 'POST', { action: 'route' }))} className="mt-2 text-sm underline">Check for new interested conversations now</button>}
      </section>
      <section aria-label="Routing rules" className="text-sm">
        <h2 className="font-semibold mb-2">Routing rules</h2>
        <p className="text-[#555] mb-2">Tried in order; the first match owns the deal. Only admins can change rules.</p>
        <ol className="list-decimal pl-5 mb-3">{active.map(r => (
          <li key={r.id}>{r.match_kind === 'any' ? 'Any conversation' : `${r.match_kind} = ${r.match_value}`} → {label(r.owner_id)}{r.sla_hours ? `, first response within ${r.sla_hours}h` : ''}
            {' '}<button className="underline text-xs" onClick={async () => done(await send('/api/pipeline/rules', 'POST', { action: 'deactivate', id: r.id }))}>turn off</button></li>
        ))}</ol>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Match" value={rule.match_kind} onChange={e => setRule({ ...rule, match_kind: e.target.value })} className="border rounded px-2 py-1"><option value="any">any conversation</option><option value="domain">sender domain</option><option value="play">play id</option></select>
          {rule.match_kind !== 'any' && <input aria-label="Match value" value={rule.match_value} onChange={e => setRule({ ...rule, match_value: e.target.value })} placeholder={rule.match_kind === 'domain' ? 'acme.com' : 'play id'} className="border rounded px-2 py-1" />}
          <select aria-label="Rule owner" value={rule.owner_id} onChange={e => setRule({ ...rule, owner_id: e.target.value })} className="border rounded px-2 py-1"><option value="">owner...</option>{owners.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
          <input aria-label="SLA hours" inputMode="numeric" value={rule.sla_hours} onChange={e => setRule({ ...rule, sla_hours: e.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="SLA hours" className="border rounded px-2 py-1 w-24" />
          <button onClick={addRule} className="px-3 py-1 rounded-lg bg-[var(--ink)] text-white">Add rule</button>
        </div>
      </section>
    </div>
  )
}
