import { requestedHiringRoles, matchedHiringRole } from '../scan/hiring-role-match.ts'
// Intent-signal enrichment from free public sources, no paid APIs:
//   funding  - SEC EDGAR full-text search for Form D filings by company name
//              (efts.sec.gov; descriptive User-Agent is required by SEC fair-access rules)
//   hiring   - public job-board APIs: Greenhouse, Lever, Ashby (keyless, read-only)
// Results land in lead_enrichments (source URL + source date required) and never
// change the lead itself. Every failure is silent: signals are a bonus, not the bar.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { addEnrichment, audit } from '../connectors/store.ts'
import { companyKey, recordCompanyEvent } from '../events/store.ts'
import { listLeads } from '../scan/store.ts'
import { classifyEntityMatch, domainSlug, withinEventWindow } from './entity-match.ts'
import { atsGtmBoard, postingEvidence, boardTitleAudit, boardCoverageRow, checkedAuditRows, checkedCoverageRow, fullListingAuditRows, fullListingCoverageRow, withRepostHistory, dedupeTitles, COVERAGE_LABEL, WINDOW_DAYS } from './ats-gtm.ts'
import { storeFilingOfficers, CONNECTOR as OFFICERS_CONNECTOR } from '../people/sec-officers.ts'
import { domainRelationship, HEURISTIC_NOTE } from './domain-basis.ts'

const TIMEOUT = 8000
const MAX_LEADS = 10
const EDGAR_UA = process.env.SEC_USER_AGENT || 'dazl/1.0 (contact: support@dazl.ai)'
const SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'gmbh', 'sarl', 'sas', 'plc', 'lp', 'llp', 'group', 'technologies', 'technology', 'labs', 'ai', 'io'])

export function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !SUFFIXES.has(t))
}

export interface FundingSignal { date: string; entity: string; url: string }
export interface HiringSignal { board: string; openRoles: number; titles: string[]; url: string; via: 'domain' | 'name'; allTitles: string[]; listedCount: number } // allTitles: a BOUNDED SAMPLE (cap 50) of every listed title; listedCount is the full deduped count before the cap, so listedCount > allTitles.length marks a truncated sample that cannot prove absence (#533)

// Latest Form D (or D/A) filing for the company within the last 18 months, but only
// when the filing entity IS the company (exact name after suffix stripping - the search
// index matches loosely, so a one-token name must not attach a same-named fund's filing).
export async function edgarFunding(company: string, fetchImpl: typeof fetch = fetch): Promise<FundingSignal | null> {
  const start = new Date(Date.now() - 548 * 86400_000).toISOString().slice(0, 10)
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${company.slice(0, 80)}"`)}&forms=D&dateRange=custom&startdt=${start}`
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': EDGAR_UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return null
    const data = await res.json() as { hits?: { hits?: { _id?: string; _source?: { display_names?: string[]; file_date?: string; adsh?: string; ciks?: string[] } }[] } }
    const hits = data.hits?.hits ?? []
    let best: { date: string; entity: string; url: string } | null = null
    for (const h of hits.slice(0, 20)) {
      const src = h._source
      const entity = (src?.display_names?.[0] ?? '').replace(/\s*\(CIK[^)]*\)\s*$/, '').trim()
      const date = src?.file_date ?? ''
      if (date && date < start) continue // startdt is not reliably honoured server-side
      const adsh = src?.adsh?.replace(/-/g, '') ?? ''
      const cik = String(Number(src?.ciks?.[0] ?? '')) // strip leading zeros
      const file = h._id?.split(':')[1] ?? ''
      if (!entity || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !adsh || !cik || cik === 'NaN' || !file) continue
      if (classifyEntityMatch(company, entity) !== 'heuristic') continue
      if (!best || date > best.date) best = { date, entity, url: `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh}/${file}` }
    }
    return best
  } catch { return null }
}

function slugCandidates(company: string, domain: string | null): string[] {
  const out: string[] = []
  const fromDomain = (domain ?? '').toLowerCase().split('.')[0]?.replace(/[^a-z0-9]/g, '')
  if (fromDomain && fromDomain.length >= 3) out.push(fromDomain)
  const fromName = company.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (fromName && fromName.length >= 3 && fromName !== fromDomain) out.push(fromName)
  return out.slice(0, 2)
}

// Job boards list the same role once per location/team, so the first three raw
// postings are often one title repeated. Dedupe case-insensitively, then cap at
// three distinct examples - the open-role count still reflects every posting.
export function topTitles<T>(jobs: T[], pick: (j: T) => string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const j of jobs) {
    const t = pick(j).trim().slice(0, 80)
    const k = t.toLowerCase()
    if (!t || seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length === 3) break
  }
  return out
}

export { withinEventWindow } from './entity-match.ts'

const get = async (url: string, fetchImpl: typeof fetch) => {
  const res = await fetchImpl(url, { headers: { 'user-agent': 'dazl/1.0', accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) return null
  try { return await res.json() } catch { return null }
}

// The source url of an N-role count is the BOARD page that lists all N roles. It is never one
// arbitrary posting (jobs[0]): that would attribute a different job's page to the aggregate. A
// single-role board links that role.
// Public job boards. Board slug guessed from the company domain (then name): a 404
// just means "no board under that slug" - no signal is recorded, nothing is faked.
// #533 review (F-B): the listing fetch outcome is reported beside the signal, so an attributed but EMPTY board
// leaves a stored trace ("the listing held 0 titles" is a complete listing, not a sample) instead of looking unchecked.
export interface CheckedBoard { board: HiringSignal['board']; url: string; via: 'domain' | 'name'; listedCount: number }
export async function atsHiringBoard(company: string, domain: string | null, fetchImpl: typeof fetch = fetch): Promise<{ signal: HiringSignal | null; checked: CheckedBoard | null }> {
  const dom = domainSlug(domain)
  let checked: CheckedBoard | null = null
  for (const slug of slugCandidates(company, domain)) {
    const via: 'domain' | 'name' = dom && slug === dom ? 'domain' : 'name'
    const gh = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, fetchImpl)
    if (Array.isArray(gh?.jobs)) {
      const jobs = gh.jobs.filter((j: { title?: string }) => typeof j?.title === 'string')
      if (jobs.length) return { signal: { board: 'greenhouse', openRoles: jobs.length, titles: topTitles(jobs, (j: { title: string }) => j.title), allTitles: dedupeTitles(jobs.map((j: { title: string }) => j.title)), listedCount: new Set(jobs.map((j: { title: string }) => j.title.trim().toLowerCase())).size, url: jobs.length === 1 && jobs[0].absolute_url ? jobs[0].absolute_url : `https://boards.greenhouse.io/${slug}`, via }, checked: null }
      if (!checked) checked = { board: 'greenhouse', url: `https://boards.greenhouse.io/${slug}`, via, listedCount: 0 }
    }
    const lever = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`, fetchImpl)
    if (Array.isArray(lever)) {
      const jobs = lever.filter((j: { text?: string }) => typeof j?.text === 'string')
      if (jobs.length) return { signal: { board: 'lever', openRoles: jobs.length, titles: topTitles(jobs, (j: { text: string }) => j.text), allTitles: dedupeTitles(jobs.map((j: { text: string }) => j.text)), listedCount: new Set(jobs.map((j: { text: string }) => j.text.trim().toLowerCase())).size, url: jobs.length === 1 && jobs[0].hostedUrl ? jobs[0].hostedUrl : `https://jobs.lever.co/${slug}`, via }, checked: null }
      if (!checked) checked = { board: 'lever', url: `https://jobs.lever.co/${slug}`, via, listedCount: 0 }
    }
    const ashby = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, fetchImpl)
    if (Array.isArray(ashby?.jobs)) {
      const jobs = ashby.jobs.filter((j: { title?: string }) => typeof j?.title === 'string')
      if (jobs.length) return { signal: { board: 'ashby', openRoles: jobs.length, titles: topTitles(jobs, (j: { title: string }) => j.title), allTitles: dedupeTitles(jobs.map((j: { title: string }) => j.title)), listedCount: new Set(jobs.map((j: { title: string }) => j.title.trim().toLowerCase())).size, url: jobs.length === 1 && jobs[0].jobUrl ? jobs[0].jobUrl : `https://jobs.ashbyhq.com/${slug}`, via }, checked: null }
      if (!checked) checked = { board: 'ashby', url: `https://jobs.ashbyhq.com/${slug}`, via, listedCount: 0 }
    }
  }
  return { signal: null, checked }
}
export async function atsHiring(company: string, domain: string | null, fetchImpl: typeof fetch = fetch): Promise<HiringSignal | null> {
  return (await atsHiringBoard(company, domain, fetchImpl)).signal
}

// Post-scan pass over a job's verified leads. Bounded, parallel within a lead,
// never throws into the runner. Audited per connector for the settings page.
export async function enrichJobSignals(db: Database.Database, tenantId: string, jobId: string, deps: { fetchImpl?: typeof fetch; creditEnrichment?: boolean; alive?: () => boolean } = {}): Promise<void> {
  if (process.env.SIGNALS_ENRICH === '0') return
  const fetchImpl = deps.fetchImpl ?? fetch
  const leads = (listLeads(db, tenantId, jobId, MAX_LEADS) as { id: string; company: string; company_domain: string | null }[]).filter(l => l.company)
  const { fundingNews, fundingRoundFor } = await import('./funding-round.ts')
  const news = process.env.SIGNALS_FUNDING_RSS === '0' ? [] : await fundingNews(fetchImpl).catch(() => [])
  const job = db.prepare('SELECT query, icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { query: string | null; icp: string | null } | undefined
  const requestedRoles = requestedHiringRoles(job?.query, job?.icp)
  const jinaLeft = { n: 2 }
  let funding = 0, hiring = 0, rounds = 0, gtm = 0, officers = 0
  const today = new Date().toISOString().slice(0, 10)
  const now = Math.floor(Date.now() / 1000)
  for (const lead of leads) {
    if (deps.alive && !deps.alive()) return // ownership lost (reclaim): the new attempt re-runs; this stale attempt writes nothing more (the reclaim failure class)
    // Company event write-through: the same fact, stored once per company for account-level
    // history. Skipped when no reliable company key exists - never guessed.
    const ck = companyKey(lead.company_domain, lead.id)
    const existingEvidence = db.prepare("SELECT kind, connector, value, source_date, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind IN ('hiring', 'hiring-role')").all(lead.id) as import('./ats-gtm.ts').ExistingEvidenceRow[]
    const [f0, hb] = await Promise.all([
      edgarFunding(lead.company, fetchImpl).catch(() => null),
      atsHiringBoard(lead.company, lead.company_domain, fetchImpl).catch(() => null),
    ])
    const h = hb?.signal ?? null
    // Postings naming contradictory company domains cannot corroborate this company: neither the dated sales / GTM roles nor the older open-role count.
    const gb = await atsGtmBoard(lead.company, lead.company_domain, fetchImpl).catch(() => ({ hiring: null, contradictory: false, checked: null, probeErrors: [] as string[], fetchAborted: true }))
    if (deps.alive && !deps.alive()) return // reclaimed DURING this lead's fetches: nothing the stale attempt resolved may be written - checked immediately after the await, before ANY write (audit rows included)
    if (lead.company_domain) {
      // #533: the generic GTM pass performs the same live board check and leaves the same per-board rows (same failure
      // class as the gate / role-match writers): settled board gets the outcome row; every probed-and-errored board its own
      // fetch_failed row; never-probed boards none; 'no_board_found' only when every probe answered cleanly; on abort the
      // COMPLETED check's row still writes but a cancel is never recorded as a board failure. results = pre-cap DEDUPED
      // LISTED TITLE count (identical titles collapse; not a posting count), -1 when not honestly attributable.
      const rel0 = domainRelationship(db, tenantId, lead.id, lead.company_domain)
      const dom0 = (x: string | null | undefined) => !!x && !!lead.company_domain && x.replace(/^www\./, '') === lead.company_domain.replace(/^www\./, '')
      const gh0 = gb.hiring, cc0 = gb.checked
      let settled0: { status: string; results: number; board: string } | null = null
      if (gb.contradictory) settled0 = { status: 'checked_rejected', results: -1, board: gh0?.board ?? cc0?.board ?? 'unknown' }
      else if (gh0) settled0 = gh0.via === 'domain' && (rel0 === 'established' || dom0(gh0.domain)) ? { status: `checked_bound${gh0.listedCountAll > gh0.allListed.length ? '_partial_capped' : ''}`, results: gh0.listedCountAll, board: gh0.board } : { status: 'checked_unbound', results: -1, board: gh0.board }
      else if (cc0) settled0 = cc0.via === 'domain' && (rel0 === 'established' || dom0(cc0.domain)) ? { status: `checked_zero_match${cc0.listedCountAll > cc0.allListed.length ? '_partial_capped' : ''}`, results: cc0.listedCountAll, board: cc0.board } : { status: 'checked_unbound', results: -1, board: cc0.board }
      if (settled0) audit(db, { tenantId, connector: 'check:ats-board', jobId, lookup: `${lead.id} (gtm) ${settled0.board}`.slice(0, 200), status: settled0.status, results: settled0.results })
      else if (gb.probeErrors.length === 0 && !gb.fetchAborted) audit(db, { tenantId, connector: 'check:ats-board', jobId, lookup: `${lead.id} (gtm)`.slice(0, 200), status: 'no_board_found', results: -1 })
      if (!gb.fetchAborted) for (const b of gb.probeErrors) if (b !== settled0?.board) audit(db, { tenantId, connector: 'check:ats-board', jobId, lookup: `${lead.id} (gtm) ${b}`.slice(0, 200), status: 'fetch_failed', results: -1 })
    }
    // A filing far from the claimed round date is a real fact about the entity but not
    // corroboration of THIS raise (fund filings and stale filings both collide here).
    // People named in the entity-matched filing (executive officers/directors): a fact about the entity, so it uses f0, not the round-date-gated f.
    if (f0) officers += await storeFilingOfficers(db, tenantId, lead.id, f0, { fetchImpl })
    const f = f0 && withinEventWindow(f0.date, (lead as { event_date?: string | null }).event_date ?? null) ? f0 : null
    if (f) {
      addEnrichment(db, tenantId, lead.id, { connector: 'signals:sec-edgar', kind: 'funding', value: `SEC Form D filed ${f.date}`, label: f.entity.slice(0, 120), confidence: 80, source_url: f.url, source_date: f.date, retrieved_at: now })
      if (ck) recordCompanyEvent(db, tenantId, { companyKey: ck, companyName: lead.company, scope: 'account', leadId: lead.id, eventType: 'sec_filing', summary: `SEC Form D filed ${f.date}`, detail: f.entity.slice(0, 120), sourceUrl: f.url, sourcePublishedAt: f.date, retrievedAt: now, confidence: 80 })
      funding++
    }
    if (h && h.via === 'domain' && !gb.contradictory) {
      // Only a board under a domain the cited page itself is hosted on (or the user confirmed) is the company's own. Otherwise the roles are shown
      // as unconfirmed, are not scored (no confidence) and are NOT written to the company's account history as hiring growth.
      const rel = domainRelationship(db, tenantId, lead.id, lead.company_domain)
      const est = rel === 'established'
      addEnrichment(db, tenantId, lead.id, { connector: `signals:${h.board}`, kind: 'hiring', value: `${est ? '' : 'Unconfirmed: '}${h.openRoles} open role${h.openRoles === 1 ? '' : 's'} (generic hiring; posting date unknown - the row date is when the board was read, not a posting date)`, label: (est ? (h.titles.join('; ') || '') : `${h.titles.join('; ')} (${HEURISTIC_NOTE})`).slice(0, 200) || null, confidence: est ? 70 : null, source_url: h.url, source_date: today, retrieved_at: now })
      if (ck && est) recordCompanyEvent(db, tenantId, { companyKey: ck, companyName: lead.company, scope: 'account', leadId: lead.id, eventType: 'hiring_surge', summary: `${h.openRoles} open role${h.openRoles === 1 ? '' : 's'}`, detail: h.titles.join('; ').slice(0, 200) || null, sourceUrl: h.url, sourcePublishedAt: null, retrievedAt: now, confidence: 70 })
      // #533: store every listed title as an audit row, so 'the requested role was not on this board' is provable later.
      const covered = new Set(h.titles.map(t => t.trim().toLowerCase()))
      for (const t of h.allTitles.filter(t => !covered.has(t.trim().toLowerCase()))) addEnrichment(db, tenantId, lead.id, { connector: `signals:${h.board}`, kind: 'hiring-role', value: `${est ? '' : 'Unconfirmed: '}${t}`.slice(0, 254), label: (est ? 'Board listing audit (all listed titles): title listed on the board; its posting date was not read' : `Board listing audit (all listed titles): title listed on the board; its posting date was not read (${HEURISTIC_NOTE})`).slice(0, 200), confidence: null, source_url: h.url.slice(0, 500), source_date: today, retrieved_at: now })
      { const auditRows = h.allTitles.filter(t => !covered.has(t.trim().toLowerCase())).length
        addEnrichment(db, tenantId, lead.id, { connector: `signals:${h.board}`, kind: 'hiring-board-coverage', value: `Board listing: ${h.listedCount} all listed titles: ${covered.size} named in the aggregate row + ${auditRows} more as audit rows${h.listedCount > h.allTitles.length ? '; sample TRUNCATED at 50 - a title beyond the sample is not disproved' : ''}`.slice(0, 254), label: COVERAGE_LABEL.slice(0, 200), confidence: null, source_url: h.url.slice(0, 500), source_date: today, retrieved_at: now }) }
      hiring++
    }
    if (!h && hb?.checked && hb.checked.via === 'domain' && !gb.contradictory) {
      const c = hb.checked
      addEnrichment(db, tenantId, lead.id, { connector: `signals:${c.board}`, kind: 'hiring-board-coverage', value: `Board checked: 0 titles listed (all listed titles) - the listing itself was empty when read, a complete listing rather than a sample`.slice(0, 254), label: COVERAGE_LABEL.slice(0, 200), confidence: null, source_url: c.url.slice(0, 500), source_date: today, retrieved_at: now })
    }
    // Dated sales / go-to-market postings from the company's own public board: the "hiring sales" half of a seed + sales request, with the
    // posting's own date. An enrichment beside the lead; it never changes the lead, its date or any verdict.
    const g = gb.hiring
    if (g) {
      const n = g.postings.length
      // A board's own NAME (even token-identical to the company) is a claim by the board, not proof of ownership: only an established domain, or the board's
      // postings all naming the lead's own domain, binds it. Otherwise: Unconfirmed, no confidence, nothing written to the company's history.
      const est = domainRelationship(db, tenantId, lead.id, lead.company_domain) === 'established' || (!!g.domain && !!lead.company_domain && g.domain.replace(/^www\./, '') === lead.company_domain.replace(/^www\./, ''))
      const titles = g.postings.map(p => p.title).slice(0, 3).join('; ') + ` (${Math.min(n, 3)} of ${n}${g.datedCapped ? '+' : ''} dated shown; ${g.listedCount} listed titles${g.listedCount > g.allTitles.length ? `, sample capped at ${g.allTitles.length}` : ''})`
      addEnrichment(db, tenantId, lead.id, { connector: `signals:${g.board}-gtm`, kind: 'hiring', value: `${est ? '' : 'Unconfirmed: '}${n}${g.datedCapped ? '+' : ''} sales/GTM role${n === 1 && !g.datedCapped ? '' : 's'} posted, newest ${g.newest}`, label: (est ? titles : `${titles} (${HEURISTIC_NOTE})`).slice(0, 200) || null, confidence: est ? 70 : null, source_url: g.url, source_date: g.newest, retrieved_at: now })
      for (const e of withRepostHistory(postingEvidence(g, now, est ? null : HEURISTIC_NOTE), g.board, existingEvidence)) addEnrichment(db, tenantId, lead.id, e)
      { const auditRows = withRepostHistory(boardTitleAudit(g, now, today, est ? null : HEURISTIC_NOTE), g.board, existingEvidence)
        for (const e of auditRows) addEnrichment(db, tenantId, lead.id, e)
        addEnrichment(db, tenantId, lead.id, boardCoverageRow(g, auditRows.length, Math.min(g.postings.length, 3), now, today)) }
      gtm++
    }
    if (!g && gb.checked && !gb.contradictory) {
      // Mirrors the nonzero path exactly: rows are written for any attributed board, Unconfirmed unless the board is bound to the lead's domain.
      const c = gb.checked
      const est = domainRelationship(db, tenantId, lead.id, lead.company_domain) === 'established' || (!!c.domain && !!lead.company_domain && c.domain.replace(/^www\./, '') === lead.company_domain.replace(/^www\./, ''))
      for (const e of withRepostHistory(checkedAuditRows(c, WINDOW_DAYS, now, today, est ? null : HEURISTIC_NOTE), c.board, existingEvidence)) addEnrichment(db, tenantId, lead.id, e)
      addEnrichment(db, tenantId, lead.id, checkedCoverageRow(c, WINDOW_DAYS, now, today))
    }
    if (requestedRoles.length) {
      const specific = await atsGtmBoard(lead.company, lead.company_domain, fetchImpl, { roleMatch: title => !!matchedHiringRole(title, requestedRoles) }).catch(() => ({ hiring: null, contradictory: false, checked: null, probeErrors: [] as string[], fetchAborted: true }))
      if (deps.alive && !deps.alive()) return // reclaimed DURING the role-match fetch: the resolved result must not be written by the stale attempt (audit rows included)
      // #533 check-history: one append-only row per completed requested-role board check, inline in the live-fetch path only;
      // an aborted attempt writes nothing (no observation), a real failure says fetch_failed, results is the exact pre-cap
      // listing count from the actual response or -1 when no count is honestly attributable.
      {
        // Same per-board truth rules as the gate writer; results = pre-cap DEDUPED LISTED TITLE count, not a posting count.
        const sc = specific.checked
        const boundS = !!specific.hiring && !specific.contradictory && (domainRelationship(db, tenantId, lead.id, lead.company_domain) === 'established' || (!!specific.hiring.domain && specific.hiring.domain === lead.company_domain))
        const boundSC = !!sc && sc.via === 'domain' && (domainRelationship(db, tenantId, lead.id, lead.company_domain) === 'established' || (!!sc.domain && !!lead.company_domain && sc.domain.replace(/^www\./, '') === lead.company_domain.replace(/^www\./, '')))
        let settled: { status: string; results: number; board: string } | null = null
        if (specific.contradictory) settled = { status: 'checked_rejected', results: -1, board: specific.hiring?.board ?? sc?.board ?? 'unknown' }
        else if (specific.hiring) settled = boundS ? { status: `checked_bound${specific.hiring.listedCountAll > specific.hiring.allListed.length ? '_partial_capped' : ''}`, results: specific.hiring.listedCountAll, board: specific.hiring.board } : { status: 'checked_unbound', results: -1, board: specific.hiring.board }
        else if (sc) settled = boundSC ? { status: `checked_zero_match${sc.listedCountAll > sc.allListed.length ? '_partial_capped' : ''}`, results: sc.listedCountAll, board: sc.board } : { status: 'checked_unbound', results: -1, board: sc.board }
        if (settled) audit(db, { tenantId, connector: 'check:ats-board', jobId, lookup: `${lead.id} (role-match) ${settled.board}`.slice(0, 200), status: settled.status, results: settled.results })
        else if (specific.probeErrors.length === 0 && !specific.fetchAborted) audit(db, { tenantId, connector: 'check:ats-board', jobId, lookup: `${lead.id} (role-match)`.slice(0, 200), status: 'no_board_found', results: -1 })
        if (!specific.fetchAborted) for (const b of specific.probeErrors) if (b !== settled?.board) audit(db, { tenantId, connector: 'check:ats-board', jobId, lookup: `${lead.id} (role-match) ${b}`.slice(0, 200), status: 'fetch_failed', results: -1 })
      }
      const matched = specific.hiring
      const bound = matched && !specific.contradictory && (domainRelationship(db, tenantId, lead.id, lead.company_domain) === 'established' || (!!matched.domain && matched.domain === lead.company_domain))
      if (matched && bound) {
        for (const e of withRepostHistory(postingEvidence(matched, now, null), matched.board, existingEvidence)) {
          const role = matchedHiringRole(e.value.split(' - posted ')[0], requestedRoles)
          if (role) addEnrichment(db, tenantId, lead.id, { ...e, label: `Requested role: ${role.term}; ${e.label}`.slice(0, 200) })
        }
        { const auditRows = withRepostHistory(boardTitleAudit(matched, now, today, null), matched.board, existingEvidence)
          for (const e of auditRows) addEnrichment(db, tenantId, lead.id, e)
          addEnrichment(db, tenantId, lead.id, boardCoverageRow(matched, auditRows.length, Math.min(matched.postings.length, 3), now, today))
          const covered = new Set(matched.allTitles.map(x => x.trim().toLowerCase())) // dated rows + filtered audit rows already cover the whole filtered sample
          const coveredCount = matched.allListed.filter(t => covered.has(t.trim().toLowerCase())).length
          const full = withRepostHistory(fullListingAuditRows(matched.board, matched.boardUrl, matched.allListed, covered, now, today, null), matched.board, existingEvidence)
          for (const e of full) addEnrichment(db, tenantId, lead.id, e) // #533 breadth: sampled titles in NEITHER dated nor filtered stores, so requested-role absence within the sample is auditable
          addEnrichment(db, tenantId, lead.id, fullListingCoverageRow(matched.board, matched.boardUrl, matched.listedCountAll, matched.allListed, coveredCount, full.length, now, today)) }
      }
      if (!matched && specific.checked && !specific.contradictory) {
        const c = specific.checked
        const boundC = c.via === 'domain' && (domainRelationship(db, tenantId, lead.id, lead.company_domain) === 'established' || (!!c.domain && !!lead.company_domain && c.domain.replace(/^www\./, '') === lead.company_domain.replace(/^www\./, '')))
        if (boundC) {
          const checkedRows = withRepostHistory(checkedAuditRows(c, WINDOW_DAYS, now, today, null), c.board, existingEvidence)
          for (const e of checkedRows) addEnrichment(db, tenantId, lead.id, e)
          addEnrichment(db, tenantId, lead.id, checkedCoverageRow(c, WINDOW_DAYS, now, today))
          const covered = new Set(checkedRows.map(r => r.value.replace(/^Unconfirmed: /, '').trim().toLowerCase())) // titles the zero-match audit just stored, actual inserted shapes
          const coveredCount = c.allListed.filter(t => covered.has(t.trim().toLowerCase())).length
          const full = withRepostHistory(fullListingAuditRows(c.board, c.boardUrl, c.allListed, covered, now, today, null), c.board, existingEvidence)
          for (const e of full) addEnrichment(db, tenantId, lead.id, e) // #533 breadth: sampled titles in NEITHER store - absence within the sample is auditable
          addEnrichment(db, tenantId, lead.id, fullListingCoverageRow(c.board, c.boardUrl, c.listedCountAll, c.allListed, coveredCount, full.length, now, today))
        }
      }
    }
    const r = await fundingRoundFor(lead.company, news, { fetchImpl, jinaLeft }).catch(() => null)
    if (r && classifyEntityMatch(lead.company, r.matched) === 'heuristic') {
      const what = [r.amount, r.stage].filter(Boolean).join(' ') || 'funding'
      addEnrichment(db, tenantId, lead.id, { connector: 'signals:funding-round', kind: 'funding', value: `Funding report: ${what} (published ${r.date}; event day unknown)`.slice(0, 254), label: `${r.matched} (reported ${r.date})`.slice(0, 200), confidence: 75, source_url: r.url, source_date: r.date, retrieved_at: now })
      if (ck) recordCompanyEvent(db, tenantId, { companyKey: ck, companyName: lead.company, scope: 'account', leadId: lead.id, eventType: 'funding_round', summary: `Funding report: ${what} (published ${r.date}; event day unknown)`.slice(0, 300), detail: r.matched.slice(0, 120), sourceUrl: r.url, sourcePublishedAt: r.date, retrievedAt: now, confidence: 75 })
      rounds++
    }
  }
  audit(db, { tenantId, connector: 'signals:sec-edgar', jobId, lookup: `${leads.length} leads`, status: funding ? 'ok' : 'empty', results: funding })
  audit(db, { tenantId, connector: OFFICERS_CONNECTOR, jobId, lookup: `${leads.length} leads`, status: officers ? 'ok' : 'empty', results: officers })
  audit(db, { tenantId, connector: 'signals:ats-gtm', jobId, lookup: `${leads.length} leads`, status: gtm ? 'ok' : 'empty', results: gtm })
  audit(db, { tenantId, connector: 'signals:ats', jobId, lookup: `${leads.length} leads`, status: hiring ? 'ok' : 'empty', results: hiring })
  audit(db, { tenantId, connector: 'signals:funding-round', jobId, lookup: `${leads.length} leads, ${news.length} raise reports`, status: rounds ? 'ok' : 'empty', results: rounds })
  // BYOK contact/firmographic pass: runs only with the tenant's own Apollo/PDL key.
  // A per-run budget control can skip this paid-credit pass for a specific run.
  if (deps.creditEnrichment !== false) {
    const { enrichLeadContacts } = await import('../enrich/index.ts')
    // A bonus, never the bar: the scan survives an enrich failure, but the failure is NEVER silent - an audit row
    // when the database allows it, a sanitized log line always.
    await enrichLeadContacts(db, tenantId, jobId, leads, { fetchImpl }).catch((e) => {
      const why = `pass failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`
      try { audit(db, { tenantId, connector: 'enrich', jobId, lookup: 'contact pass', status: why, results: 0 }) } catch { /* db down: the log line still carries it */ }
      console.error('[enrich]', why)
    })
  }
}

export function newId(): string { return randomBytes(12).toString('hex') }
