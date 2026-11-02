import type Database from 'better-sqlite3'
import { ownerGuarded, spendRefused } from '../llm/owner-guard.ts'
import { randomBytes } from 'node:crypto'
import { audit, getEnabledCredential } from '../connectors/store.ts'
import { hasConsent, httpWorker, type WorkerFetch } from '../advanced/index.ts'
import { PLATFORM_SUPPORT } from '../advanced/config.ts'
import { advFlags, connectorId, maxCallsPerHour, platformAllowed, scopeFor } from '../advanced/config.ts'
import { readKey, keyStatus } from '../llm/key-store.ts'
import { getAuthDb, getSellerProfile } from '../auth-db.ts'
import { providers, ProviderError } from '../llm/provider.ts'
import type { Vendor } from '../llm/vendors.ts'

// Reviewed thread replies: surface fresh Reddit/X threads where a buyer asks a question the
// tenant's product answers, draft a reply on the tenant's OWN AI key, and hand back text.
// dazl never posts. The user reviews, edits, copies the reply and posts it by hand from their
// own logged-in session (the "Copy & open thread" action). Automated posting is out of scope:
// the platforms' automation terms and the tenant's account risk are documented in
// docs/reviewed-thread-replies.md. LinkedIn is deliberately excluded (separate consent scope,
// highest ban risk). Reads reuse the tenant's own session worker: same consent scope, same
// per-platform hourly budget as every other advanced fetcher.

export const REPLY_PLATFORMS = ['reddit', 'x'] as const
export type ReplyPlatform = (typeof REPLY_PLATFORMS)[number]
export const MAX_QUERIES = 5
export const MAX_THREAD_AGE_DAYS = 14
const MAX_NEW_PER_QUERY = 10
const id24 = () => randomBytes(12).toString('hex')

export function migrateThreadReplies(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reply_queries (
      tenant_id  TEXT NOT NULL,
      query      TEXT NOT NULL,
      position   INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, query)
    );
    CREATE TABLE IF NOT EXISTS reply_threads (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      platform     TEXT NOT NULL CHECK (platform IN ('reddit','x')),
      url          TEXT NOT NULL,
      title        TEXT NOT NULL,
      quote        TEXT NOT NULL,
      query        TEXT NOT NULL,
      date         TEXT,
      login_walled INTEGER NOT NULL DEFAULT 0,
      buyer_intent TEXT CHECK (buyer_intent IS NULL OR buyer_intent IN ('yes','no','uncertain')),
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      UNIQUE (tenant_id, url)
    );
    -- buyer_intent: NULL = keyword-matched only (no model verdict), else the tenant-key
    -- model verdict: 'yes' | 'uncertain' shown with a label, 'no' hidden from the list.
    -- A model verdict is a heuristic signal for review, never proof of buyer intent.
  `)
  try { db.exec("ALTER TABLE reply_threads ADD COLUMN buyer_intent TEXT CHECK (buyer_intent IS NULL OR buyer_intent IN ('yes','no','uncertain'))") } catch { /* column exists */ }
  db.exec(`
    CREATE INDEX IF NOT EXISTS reply_threads_tenant ON reply_threads (tenant_id, created_at);
    CREATE TABLE IF NOT EXISTS reply_drafts (
      thread_id  TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      draft      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','edited','copied','posted')),
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
  `)
}

export function cleanQuery(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
}

export function listQueries(db: Database.Database, tenantId: string): string[] {
  return (db.prepare('SELECT query FROM reply_queries WHERE tenant_id = ? ORDER BY position').all(tenantId) as { query: string }[]).map(r => r.query)
}

export function setQueries(db: Database.Database, tenantId: string, queries: string[]): { ok: boolean; error?: string; queries: string[] } {
  const cleaned = [...new Set(queries.map(cleanQuery).filter(Boolean))]
  if (cleaned.length > MAX_QUERIES) return { ok: false, error: `Up to ${MAX_QUERIES} searches`, queries: [] }
  for (const q of cleaned) if (q.length < 3) return { ok: false, error: 'Searches need at least 3 characters', queries: [] }
  db.prepare('DELETE FROM reply_queries WHERE tenant_id = ?').run(tenantId)
  const ins = db.prepare('INSERT INTO reply_queries (tenant_id, query, position) VALUES (?, ?, ?)')
  cleaned.forEach((q, i) => ins.run(tenantId, q, i))
  return { ok: true, queries: cleaned }
}

// Buyer questions, not chatter: the thread title has to look like someone asking.
const QUESTION_WORD = /^(who|what|which|where|when|why|how|is|are|does|do|did|can|could|should|would|has|have|any|anyone|anybody|best|recommend|recommendations|looking|thoughts|experience|experiences|worth)\b/i
export function looksLikeQuestion(title: string): boolean {
  const t = title.trim()
  return t.includes('?') || QUESTION_WORD.test(t)
}

const STOPWORDS = new Set(['a','an','the','for','to','of','in','on','and','or','my','your','our','is','are','do','does','how','what','which','best','top','any','with','about'])

// Topical relevance gate. Platform search matches loosely (a query for "cold email
// software" returns GPA advice and cold-case posts), so retrieval candidates are NOT
// presented as fits unless they actually talk about the query. Rule (a heuristic,
// deliberately strict - a missed borderline thread beats an irrelevant one presented
// as a fit): the query phrase appears in the title or quote, or enough of the query's
// content words do (all for 1-2 word queries, at least two thirds for longer ones).
export function isRelevantToQuery(query: string, title: string, quote: string): boolean {
  const text = `${title} ${quote}`.toLowerCase()
  const q = query.trim().toLowerCase()
  if (!q) return false
  if (text.includes(q)) return true
  const words = q.split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOPWORDS.has(w))
  if (words.length === 0) return text.includes(q)
  const present = words.filter(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text)).length
  const need = words.length <= 2 ? words.length : Math.ceil(words.length * 2 / 3)
  return present >= need
}

// Buyer-intent grading at refresh: the keyword gate keeps topically matching threads, but
// a student asking who to cold-email for internships matches "cold email software" without
// being a buyer. When the tenant has an enabled AI key, each keyword-qualified candidate
// gets one short verdict call on the TENANT'S OWN key (same BYOK path as reply drafting),
// judged against the tenant's stored seller profile. Verdicts: 'yes' or 'uncertain' are
// stored and labelled; 'no' is filtered at ingestion like other irrelevant candidates.
// No key or a provider error stores NULL - the thread stays keyword-matched only, and the
// page keeps saying so. Grading is capped per refresh for spend discipline.
export const MAX_INTENT_GRADES_PER_REFRESH = 10
const INTENT_PROMPT = (sells: string, website: string, t: { title: string; quote: string }) => `Someone sells: ${sells || '(not specified)'}${website ? ` (${website})` : ''}.

A thread titled "${t.title.slice(0, 200)}" says: "${t.quote.slice(0, 400)}"

Is the person who wrote this plausibly a BUYER of what the seller sells - someone with the problem the product solves, evaluating or asking about solutions? Job seekers, students, researchers, and people who merely mention the product category for an unrelated goal are NOT buyers.
Answer with exactly one word: yes, no, or uncertain.`

export type BuyerIntent = 'yes' | 'uncertain'

// Returns null when no verdict can be made (no key, unreadable key, provider error,
// unparseable answer) - callers store NULL and keep the keyword-matched label.
export async function gradeBuyerIntent(
  db: Database.Database, tenantId: string,
  candidate: { title: string; quote: string },
  deps: { fetchImpl?: typeof fetch; master?: Buffer; sells?: string; website?: string } = {},
): Promise<BuyerIntent | 'no' | null> {
  const vendor = (keyStatus(db, tenantId)[0]?.vendor ?? null) as Vendor | null
  if (!vendor) return null
  // readKey, not getKey: an unreadable stored key must leave rows ungraded, never 500 the refresh.
  const key = readKey(db, tenantId, vendor, deps.master).key
  if (!key) return null
  let out: string
  try {
    out = (await ownerGuarded(db, tenantId, providers[vendor]).complete!(key, INTENT_PROMPT(deps.sells ?? '', deps.website ?? '', candidate), deps.fetchImpl ?? fetch, 200)).trim().toLowerCase()
  } catch { return null }
  const word = out.split(/[^a-z]+/)[0]
  return word === 'yes' ? 'yes' : word === 'no' ? 'no' : word === 'uncertain' ? 'uncertain' : null
}

// Replies share each platform's hourly budget with every other advanced feature.
function platformCallsLastHour(db: Database.Database, tenantId: string, p: ReplyPlatform): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM connector_audit WHERE tenant_id = ? AND (connector = ? OR connector LIKE ?) AND created_at > CAST(strftime('%s','now') AS INTEGER) - 3600").get(tenantId, `adv:${p}`, `adv:${p}-%`) as { n: number }
  return r.n
}

export interface RefreshResult {
  added: number
  filtered: number
  // Buyer-intent grading on the tenant's own key during THIS refresh. graded counts new
  // verdicts made (both platforms and re-grades of older rows); ungraded_remaining is the
  // honest backlog still keyword-only after the per-refresh cap - one click may not grade all.
  graded: number
  ungraded_remaining: number
  platforms: Partial<Record<ReplyPlatform, 'ok' | 'disabled' | 'no_consent' | 'rate_limited' | 'worker_error' | 'unsupported'>>
}

export async function refreshReplies(db: Database.Database, tenantId: string, deps: { worker?: WorkerFetch; fetchImpl?: typeof fetch; master?: Buffer; env?: Record<string, string | undefined>; now?: number } = {}): Promise<RefreshResult> {
  const env = deps.env ?? process.env
  const flags = advFlags(env)
  const queries = listQueries(db, tenantId).slice(0, MAX_QUERIES)
  const out: RefreshResult = { added: 0, filtered: 0, graded: 0, ungraded_remaining: 0, platforms: {} }
  if (queries.length === 0) return out
  const now = deps.now ?? Date.now()
  const cutoff = now - MAX_THREAD_AGE_DAYS * 86400_000
  const worker = deps.worker ?? httpWorker(env)
  const ins = db.prepare('INSERT OR IGNORE INTO reply_threads (id, tenant_id, platform, url, title, quote, query, date, login_walled, buyer_intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  // Seller context + grading budget are resolved once per refresh, not per candidate.
  // Seller context is a bonus, never the bar: if the auth db is unavailable the grading
  // prompt runs with an empty profile rather than failing the refresh.
  let sells = ''
  let website = ''
  try {
    const profile = getSellerProfile(getAuthDb(), tenantId)
    sells = profile.sells
    website = profile.website
  } catch { /* keyword gate already applied; refresh continues */ }
  let gradesLeft = MAX_INTENT_GRADES_PER_REFRESH
  for (const p of REPLY_PLATFORMS) {
    if (!platformAllowed(p, flags)) { out.platforms[p] = 'disabled'; continue }
    // A platform this build cannot fetch is 'unsupported', never a silently successful read.
    if (!PLATFORM_SUPPORT[p].supported) { out.platforms[p] = 'unsupported'; continue }
    if (!hasConsent(db, tenantId, scopeFor(p))) { out.platforms[p] = 'no_consent'; continue }
    const budget = maxCallsPerHour(p, env) - platformCallsLastHour(db, tenantId, p)
    if (budget <= 0) { out.platforms[p] = 'rate_limited'; continue }
    const session = getEnabledCredential(db, tenantId, connectorId(p), deps.master) || ''
    const connector = `adv:${p}-replies`
    let anyError = false
    let anyUnsupported = false
    for (const q of queries.slice(0, budget)) {
      const r = await worker({ platform: p, query: q, session }).catch(() => null)
      if (r === null) { audit(db, { tenantId, connector, lookup: q, status: 'worker_error', results: 0 }); anyError = true; continue }
      // Version skew: the worker refuses a platform this build still reads. Not an error, not ok.
      if (r.unsupported) { audit(db, { tenantId, connector, lookup: q, status: 'unsupported', results: 0 }); anyUnsupported = true; continue }
      const items = r.items
      const fresh = items.filter(i => i.date && new Date(i.date).getTime() >= cutoff && looksLikeQuestion(i.title))
      let qualified = fresh.filter(i => isRelevantToQuery(q, i.title, i.quote))
      out.filtered += fresh.length - qualified.length
      const graded: ({ title: string; quote: string } & typeof qualified[number] & { buyer_intent: string | null })[] = []
      for (const it of qualified) {
        let buyer_intent: string | null = null
        if (gradesLeft > 0) {
          gradesLeft--
          const verdict = await gradeBuyerIntent(db, tenantId, it, { fetchImpl: deps.fetchImpl, master: deps.master, sells, website })
          if (verdict !== null) out.graded++
          if (verdict === 'no') { out.filtered++; continue }
          buyer_intent = verdict
        }
        graded.push({ ...it, buyer_intent })
      }
      qualified = graded as unknown as typeof qualified
      audit(db, { tenantId, connector, lookup: q, status: qualified.length ? 'ok' : fresh.length ? 'filtered' : 'empty', results: qualified.length })
      for (const it of qualified.slice(0, MAX_NEW_PER_QUERY)) {
        out.added += ins.run(id24(), tenantId, p, it.url, it.title, it.quote, q, it.date, it.login_walled ? 1 : 0, (it as { buyer_intent?: string | null }).buyer_intent ?? null).changes
      }
    }
    out.platforms[p] = anyError ? 'worker_error' : anyUnsupported ? 'unsupported' : 'ok'
  }
  // Re-grade older keyword-only rows with whatever of the manual-refresh cap remains, so a
  // tenant who adds a key later is not stuck with pre-grading rows (like the internship
  // thread) forever. Bounded, user-initiated, their own key - not a silent backfill.
  if (gradesLeft > 0) {
    const ungraded = db.prepare("SELECT id, title, quote FROM reply_threads WHERE tenant_id = ? AND buyer_intent IS NULL ORDER BY created_at DESC LIMIT ?").all(tenantId, gradesLeft) as { id: string; title: string; quote: string }[]
    const upd = db.prepare('UPDATE reply_threads SET buyer_intent = ? WHERE tenant_id = ? AND id = ? AND buyer_intent IS NULL')
    for (const t of ungraded) {
      const verdict = await gradeBuyerIntent(db, tenantId, t, { fetchImpl: deps.fetchImpl, master: deps.master, sells, website })
      if (verdict === null) continue
      upd.run(verdict, tenantId, t.id)
      out.graded++
      if (verdict === 'no') out.filtered++
    }
  }
  out.ungraded_remaining = (db.prepare('SELECT COUNT(*) AS n FROM reply_threads WHERE tenant_id = ? AND buyer_intent IS NULL').get(tenantId) as { n: number }).n
  return out
}

export interface ThreadRow {
  id: string; platform: ReplyPlatform; url: string; title: string; quote: string; query: string
  date: string | null; login_walled: number; created_at: number; buyer_intent?: string | null
  draft: string | null; draft_status: 'draft' | 'edited' | 'copied' | 'posted' | null; draft_updated_at: number | null
}

export function listThreads(db: Database.Database, tenantId: string, limit = 50): ThreadRow[] {
  const rows = db.prepare(
    `SELECT t.id, t.platform, t.url, t.title, t.quote, t.query, t.date, t.login_walled, t.created_at, t.buyer_intent,
            d.draft, d.status AS draft_status, d.updated_at AS draft_updated_at
     FROM reply_threads t LEFT JOIN reply_drafts d ON d.thread_id = t.id AND d.tenant_id = t.tenant_id
     WHERE t.tenant_id = ? ORDER BY t.created_at DESC LIMIT ?`).all(tenantId, limit) as ThreadRow[]
  // Re-qualify at read time: threads stored before the relevance gate existed must not
  // keep presenting as fits. A thread the tenant already engaged with (a draft exists)
  // stays visible - their work is not hidden.
  return rows.filter(t => t.draft !== null || (t.buyer_intent !== 'no' && isRelevantToQuery(t.query, t.title, t.quote)))
}

export function getThread(db: Database.Database, tenantId: string, id: string): ThreadRow | undefined {
  return listThreads(db, tenantId, 200).find(t => t.id === id)
}

export function dismissThread(db: Database.Database, tenantId: string, id: string): boolean {
  if (!/^[a-f0-9]{24}$/.test(id)) return false
  db.prepare('DELETE FROM reply_drafts WHERE tenant_id = ? AND thread_id = ?').run(tenantId, id)
  return db.prepare('DELETE FROM reply_threads WHERE tenant_id = ? AND id = ?').run(tenantId, id).changes > 0
}

const PROMPT = (p: ReplyPlatform, t: ThreadRow, sells: string, website: string) => `You are writing a reply to a ${p === 'x' ? 'post on X (Twitter)' : 'Reddit thread'}.

Platform norms: answer the question directly first, be specific and genuinely useful, plain conversational tone. No hype, no buzzwords, no emojis.${p === 'reddit' ? ' Reddit reacts badly to marketing: never pitch. Mention the product only if it is a direct fit, and say you built it if you do.' : ' Keep it short; under 280 characters is best.'}

Thread title: "${t.title}"
Thread text: "${t.quote}"

The person you are writing for sells: ${sells || '(not specified)'}${website ? ` (${website})` : ''}

Rules: answer the question first; do not invent features, prices, customers or statistics; mention the product only when it directly fits the question; at most one link; never claim to be a customer.
Return only the reply text, 120 words maximum.`

export type DraftResult = { draft: string; status: 'draft' } | { error: 'no_key' | 'not_found' | 'upstream' | 'key_unreadable' | 'key_rejected' | 'spend_limit' }

export async function draftReply(db: Database.Database, tenantId: string, threadId: string, profile: { sells: string; website: string }, deps: { fetchImpl?: typeof fetch; master?: Buffer; now?: number } = {}): Promise<DraftResult> {
  const t = getThread(db, tenantId, threadId)
  if (!t) return { error: 'not_found' }
  const vendor = (keyStatus(db, tenantId)[0]?.vendor ?? null) as Vendor | null
  if (!vendor) return { error: 'no_key' }
  const read = readKey(db, tenantId, vendor, deps.master)
  if (read.unreadable) return { error: 'key_unreadable' }
  const key = read.key
  if (!key) return { error: 'no_key' }
  let draft: string
  try {
    draft = (await ownerGuarded(db, tenantId, providers[vendor]).complete!(key, PROMPT(t.platform, t, profile.sells, profile.website), deps.fetchImpl ?? fetch, 800)).trim()
  } catch (e) {
    if (spendRefused(e)) return { error: 'spend_limit' }
    if (e instanceof ProviderError && e.kind === 'auth') return { error: 'key_rejected' }
    return { error: 'upstream' }
  }
  if (draft.length < 20) return { error: 'upstream' }
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  db.prepare(`INSERT INTO reply_drafts (thread_id, tenant_id, draft, status, updated_at) VALUES (?, ?, ?, 'draft', ?)
              ON CONFLICT(thread_id) DO UPDATE SET draft = excluded.draft, status = 'draft', updated_at = excluded.updated_at`).run(threadId, tenantId, draft.slice(0, 4000), now)
  return { draft, status: 'draft' }
}

export function saveDraft(db: Database.Database, tenantId: string, threadId: string, text: string): { ok: boolean; error?: string } {
  const draft = text.trim()
  if (draft.length < 1 || draft.length > 4000) return { ok: false, error: 'Reply text must be 1-4000 characters' }
  const r = db.prepare("UPDATE reply_drafts SET draft = ?, status = 'edited', updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE tenant_id = ? AND thread_id = ?").run(draft, tenantId, threadId)
  return r.changes > 0 ? { ok: true } : { ok: false, error: 'Write a draft first' }
}

export function markDraft(db: Database.Database, tenantId: string, threadId: string, status: 'copied' | 'posted'): boolean {
  return db.prepare('UPDATE reply_drafts SET status = ?, updated_at = CAST(strftime(\'%s\',\'now\') AS INTEGER) WHERE tenant_id = ? AND thread_id = ?').run(status, tenantId, threadId).changes > 0
}
