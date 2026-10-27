// Postgres implementation of the LeadsReadDb slice contract (W1 architecture proof).
// SQL ported from the SQLite store modules: ? -> $n parameters, IN-list expansion,
// strftime -> extract(epoch). TS post-processing is identical logic to the SQLite
// path; the contract test (leads-read-db.test.ts) pins equivalence on synthetic data.
// Works against any PgQueryable (pg.Pool, pg.Client, or pg-mem's adapter).
import type { LeadsReadDb } from './leads-read.ts'
import { STALE_RUNNING_S, MAX_ATTEMPTS } from '../scan/store.ts'
import { GAPS_S, TEST_GAPS_S, MAX_STEPS } from '../outreach/sequences.ts'
import { eventTimingFresh } from '../events/store.ts'
import type { CompanyEventRow, EventScope, EventType } from '../events/store.ts'
import { groupUnderlyingEvents, scoreEvidence } from '../events/prioritize.ts'
import type { LeadPriority } from '../events/prioritize.ts'
import { tokens, MIN_COHORT } from '../scan/lookalike.ts'
import type { LookalikeSignal } from '../scan/lookalike.ts'

type CohortRow = { id: string; signal: string; industry: string | null; location: string | null }

export interface PgQueryable { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }

const norm = (e: string) => e.trim().toLowerCase()

// Numeric policy: sqlite INTEGER maps to BIGINT in the translated PG schema,
// and the pg driver returns int8 (OID 20) values as STRINGS. pg-mem returns
// numbers, which masks this - every numeric column is coerced explicitly with
// a safe-integer check. A value beyond 2^53 fails loudly instead of silently
// losing precision.
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error(`unsafe integer from pg: ${v}`)
  return n
}
const numReq = (v: unknown): number => {
  const n = num(v)
  if (n === null) throw new Error('unexpected NULL numeric from pg')
  return n
}

export function pgLeadsRead(pg: PgQueryable): LeadsReadDb {
  return {
    async getJob(userId, id) {
      const cutoff = Math.floor(Date.now() / 1000) - STALE_RUNNING_S
      await pg.query(
        `UPDATE scan_jobs SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
           error = CASE WHEN attempts >= $1 THEN 'timeout' ELSE error END,
           finished_at = CASE WHEN attempts >= $1 THEN CAST(floor(extract(epoch from now())) AS BIGINT) ELSE finished_at END,
           claimed_at = NULL
         WHERE status = 'running' AND claimed_at < $2`,
        [MAX_ATTEMPTS, cutoff],
      )
      const { rows } = await pg.query(
        'SELECT id, status, error, query, icp, icp_inferred, created_at, claimed_at, attempts, finished_at, candidates, verified, needs_review, dropped, drop_reasons, industry, location FROM scan_jobs WHERE id = $1 AND user_id = $2',
        [id, userId],
      )
      const job = rows[0] as Record<string, unknown> | undefined
      if (!job) return undefined
      const c = await pg.query('SELECT count(*) AS n FROM leads WHERE scan_job_id = $1', [id])
      return {
        ...job,
        icp_inferred: num(job.icp_inferred),
        created_at: numReq(job.created_at), claimed_at: num(job.claimed_at), attempts: numReq(job.attempts), finished_at: num(job.finished_at),
        candidates: num(job.candidates), verified: num(job.verified),
        needs_review: num(job.needs_review), dropped: num(job.dropped),
        lead_count: numReq((c.rows[0] as { n: number | string }).n),
      } as never
    },

    async listLeads(userId, jobId, limit = 200, includeHidden = false) {
      const { rows } = await pg.query(
        `SELECT l.id, l.scan_job_id, l.name, l.company, l.contact, l.signal, l.source_url, l.score, l.created_at,
l.evidence_excerpt, l.event_date, l.date_status, l.retrieved_at, l.confidence, l.review_reason, l.company_domain,
l.human_confirmed_at, l.human_confirmed_from, l.source_kind, l.quarantined_at, l.quarantine_reason, l.evidence_origin, l.own_fetch_failure, l.evidence_copy_sha256, l.evidence_copy_id,
           l.fit, l.intent, l.action, l.why, l.signals, l.icp_match, l.watch_new, l.seen_before, l.stage
         FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
         WHERE j.id = $1 AND j.user_id = $2 ${includeHidden ? '' : 'AND (l.fit IS NULL OR l.fit > 1)'}
         ORDER BY (l.fit IS NULL), l.fit DESC, l.action DESC, (l.confidence IS NULL), l.confidence DESC, l.score DESC, l.created_at DESC LIMIT $3`,
        [jobId, userId, Math.min(limit, 500)],
      )
      return (rows as Record<string, unknown>[]).map(r => ({
        ...r,
        score: numReq(r.score), created_at: numReq(r.created_at), retrieved_at: num(r.retrieved_at),
        confidence: num(r.confidence), fit: num(r.fit), intent: num(r.intent), action: num(r.action),
        watch_new: num(r.watch_new), seen_before: num(r.seen_before), human_confirmed_at: num(r.human_confirmed_at),
      })) as never
    },

    async countHiddenLeads(userId, jobId) {
      const { rows } = await pg.query(
        'SELECT count(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.id = $1 AND j.user_id = $2 AND l.fit IS NOT NULL AND l.fit <= 1',
        [jobId, userId],
      )
      return numReq((rows[0] as { n: number | string }).n) as never
    },

    async sequenceStatusByLead(tenantId) {
      const { rows } = await pg.query(
        `SELECT s.lead_id, s.status, s.stop_reason, s.to_email, m.sent_at AS step1_sent,
                COALESCE(st.sent_steps, 0) + CASE WHEN m.status = 'sent' THEN 1 ELSE 0 END AS steps_sent
         FROM sequences s JOIN outreach_messages m ON m.id = s.message_id
         LEFT JOIN (SELECT tenant_id, sequence_id, count(*) AS sent_steps FROM sequence_steps WHERE step > 1 AND status = 'sent' GROUP BY tenant_id, sequence_id) st
           ON st.tenant_id = s.tenant_id AND st.sequence_id = s.id
         WHERE s.tenant_id = $1`,
        [tenantId],
      )
      const t = await pg.query('SELECT test_addresses FROM sequence_settings WHERE tenant_id = $1', [tenantId])
      let testList: string[] = []
      try { testList = (JSON.parse((t.rows[0] as { test_addresses: string } | undefined)?.test_addresses ?? '[]') as string[]).map(norm) } catch { testList = [] }
      const out = new Map<string, { status: string; step: number; next_due_at: number | null; stop_reason: string | null }>()
      for (const r of rows as { lead_id: string; status: string; stop_reason: string | null; to_email: string; step1_sent: number | string | null; steps_sent: number | string }[]) {
        const stepsSent = numReq(r.steps_sent)
        const step1Sent = num(r.step1_sent)
        let nextDue: number | null = null
        if ((r.status === 'active' || r.status === 'approved') && step1Sent && stepsSent < MAX_STEPS) {
          const gaps = testList.includes(norm(r.to_email)) ? TEST_GAPS_S : GAPS_S
          nextDue = step1Sent + gaps[stepsSent]
        }
        out.set(r.lead_id, { status: r.status, step: stepsSent, next_due_at: nextDue, stop_reason: r.stop_reason })
      }
      return out as never
    },

    async enrichmentsForLeads(tenantId, leadIds) {
      const out: Record<string, unknown[]> = {}
      if (leadIds.length === 0) return out as never
      const ph = leadIds.map((_, i) => `$${i + 2}`).join(',')
      const { rows } = await pg.query(
        `SELECT lead_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at FROM lead_enrichments WHERE tenant_id = $1 AND lead_id IN (${ph})`,
        [tenantId, ...leadIds],
      )
      for (const row of rows as ({ lead_id: string } & Record<string, unknown>)[]) {
        const { lead_id, ...e } = row
        e.confidence = num(e.confidence)
        e.retrieved_at = num(e.retrieved_at)
        ;(out[lead_id] ??= []).push(e)
      }
      return out as never
    },

    async eventsForLeads(tenantId, leads, opts = {}) {
      const now = opts.now ?? Math.floor(Date.now() / 1000)
      const list = async (companyKey: string): Promise<CompanyEventRow[]> => {
        const { rows } = await pg.query(
          `SELECT id, company_key, company_name, scope, lead_id, event_type, summary, detail, source_url, source_published_at, retrieved_at, first_seen_at, last_seen_at, confidence
           FROM company_events WHERE tenant_id = $1
             AND ($2::text IS NULL OR company_key = $2) AND ($3::text IS NULL OR scope = $3)
           ORDER BY last_seen_at DESC LIMIT $4`,
          [tenantId, companyKey, 'account', 200],
        )
        return (rows as Omit<CompanyEventRow, 'fresh'>[]).map(r => {
          const coerced = {
            ...r,
            retrieved_at: numReq(r.retrieved_at), first_seen_at: numReq(r.first_seen_at),
            last_seen_at: numReq(r.last_seen_at), confidence: num(r.confidence),
          }
          return { ...coerced, fresh: eventTimingFresh(coerced, now) }
        })
      }
      const out: Record<string, CompanyEventRow[]> = {}
      for (const l of leads) {
        const d = (l.company_domain ?? '').toLowerCase().replace(/^www\./, '').trim()
        const keys = d.includes('.') ? [d, `lead:${l.id}`] : [`lead:${l.id}`]
        const seen = new Set<string>()
        const seenObservation = new Set<string>()
        const rows: CompanyEventRow[] = []
        for (const k of keys) for (const e of await list(k)) {
          if (seen.has(e.id)) continue
          const obs = `${e.event_type}|${e.source_url}`
          if (seenObservation.has(obs)) continue
          seen.add(e.id)
          seenObservation.add(obs)
          rows.push(e)
        }
        rows.sort((a, b) => b.last_seen_at - a.last_seen_at)
        if (rows.length) out[l.id] = rows
      }
      return out as never
    },

    async leadPriorities(tenantId, leads, opts = {}) {
      const now = opts.now ?? Math.floor(Date.now() / 1000)
      const events = await this.eventsForLeads(tenantId, leads, { now })
      const out: Record<string, LeadPriority> = {}
      for (const l of leads) {
        const rows = events[l.id] ?? []
        const scored = scoreEvidence(groupUnderlyingEvents(rows, now))
        out[l.id] = {
          graded: l.fit !== null && l.intent !== null && l.action !== null,
          fit: l.fit, intent: l.intent, action: l.action,
          ...scored,
        }
      }
      return out as never
    },

    async lookalikeSignals(tenantId, leads) {
      const out = new Map<string, LookalikeSignal>()
      if (leads.length === 0) return out as never
      const exclude = new Set(leads.map(l => l.id))
      const { rows } = await pg.query(
        `SELECT DISTINCT l.id, l.signal, j.industry, j.location
         FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
         LEFT JOIN suppressions s ON s.tenant_id = j.user_id AND s.email = lower(btrim(l.contact))
         WHERE j.user_id = $1
           AND (l.source_kind IS NULL OR l.source_kind <> 'test')
           AND l.company NOT LIKE '%(test only)%'
           AND s.email IS NULL
           AND (l.fit >= 4 OR l.id IN (SELECT lead_id FROM inbound_messages WHERE tenant_id = $2 AND classification = 'positive' AND lead_id IS NOT NULL))
         LIMIT 200`,
        [tenantId, tenantId],
      )
      const cohort = (rows as CohortRow[]).filter(r => !exclude.has(r.id))
      const cohortTok = cohort.map(c => ({ row: c, tok: tokens(c.signal) }))
      for (const l of leads) {
        if (cohort.length < MIN_COHORT) { out.set(l.id, { state: 'insufficient', cohort_size: cohort.length, matches: 0, matched_on: [] }); continue }
        const lt = tokens(l.signal)
        let matches = 0
        const on = new Set<string>()
        for (const c of cohortTok) {
          let hit = false
          let shared = 0
          for (const t of lt) if (c.tok.has(t)) shared++
          if (shared >= 2) { hit = true; on.add('signal keywords') }
          if (l.industry && c.row.industry && l.industry === c.row.industry) { hit = true; on.add('industry') }
          if (l.location && c.row.location && l.location === c.row.location) { hit = true; on.add('location') }
          if (hit) matches++
        }
        out.set(l.id, { state: 'scored', cohort_size: cohort.length, matches, matched_on: [...on] })
      }
      return out as never
    },
  }
}
