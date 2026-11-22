// ATS board index (Refs #1122; Gagan 2026-11-22: "stop hand-building what open source already does").
// Public Ashby / Greenhouse / Lever board slugs are enumerated from Common Crawl's free CDX index (index.commoncrawl.org) and
// stored as DATA, never as a list in code. A board's postings are read later from its own official public API (ats-index-poll.ts),
// off any scan: nothing here runs inside a scan or counts against a scan's budget.
// Every slug row records where it came from: 'commoncrawl:<crawl id>' or 'past_leads' (the source URLs of leads already stored).
import type Database from 'better-sqlite3'
import type { AtsKind } from './ats-posting.ts'

export function migrateAtsIndex(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ats_boards (
      kind TEXT NOT NULL CHECK (kind IN ('ashby','greenhouse','lever')),
      slug TEXT NOT NULL,
      source TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_polled INTEGER,
      next_poll INTEGER NOT NULL DEFAULT 0,
      poll_status TEXT,
      company TEXT,
      website TEXT,
      PRIMARY KEY (kind, slug)
    );
    CREATE INDEX IF NOT EXISTS ats_boards_next_poll ON ats_boards(next_poll);
    CREATE TABLE IF NOT EXISTS ats_index_cursor (
      crawl TEXT NOT NULL,
      pattern TEXT NOT NULL,
      pages INTEGER,
      next_page INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (crawl, pattern)
    );
  `)
}

const HOST_KIND: Record<string, AtsKind> = { 'jobs.ashbyhq.com': 'ashby', 'boards.greenhouse.io': 'greenhouse', 'job-boards.greenhouse.io': 'greenhouse', 'jobs.lever.co': 'lever' }
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
// Path words of the board hosts themselves (their own pages and assets), not an employer's board.
const HOST_PATHS = new Set(['embed', 'api', 'v1', 'static', 'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'privacy', 'terms', 'login', 'signin', 'search', 'jobs', 'careers', 'job_app', 'includes', 'js', 'css', 'images', 'fonts', '_next', 'cdn-cgi'])

// One board slug from a board-host URL (a posting URL or a board root, with or without query/trailing path). Lowercased:
// all three hosts answer their board API case-insensitively, so case variants are one board.
export function boardSlugOf(raw: string): { kind: AtsKind; slug: string } | null {
  let u: URL
  try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`) } catch { return null }
  const kind = HOST_KIND[u.hostname.toLowerCase()]
  if (!kind) return null
  const seg = decodeURIComponent(u.pathname.split('/')[1] ?? '').trim()
  if (!seg || !SLUG.test(seg)) return null
  const slug = seg.toLowerCase()
  if (HOST_PATHS.has(slug) || /\.(?:js|css|png|svg|ico|xml|txt|json)$/.test(slug)) return null
  return { kind, slug }
}

// One slug per board from CDX lines (a block line or a query-server JSON line). A capture of a board path names the board even when the
// host refused the crawler (Lever answers Common Crawl 403); a 404/410 capture does not. A slug that is no board is pruned by the poller.
export function slugsFromCdx(body: string): { kind: AtsKind; slug: string }[] {
  const seen = new Map<string, { kind: AtsKind; slug: string }>()
  for (const line of body.split('\n')) {
    // a cdx-*.gz line is "<surt> <timestamp> {json}"; the query server answers the JSON alone
    const t = line.trim(), j = t.indexOf('{'); if (j < 0) continue
    let rec: unknown; try { rec = JSON.parse(t.slice(j)) } catch { continue }
    const r = rec as { url?: unknown; status?: unknown } | null
    if (!r || typeof r !== 'object' || ['404', '410'].includes(String(r.status))) continue
    const url = typeof r.url === 'string' ? r.url : null
    const s = url ? boardSlugOf(url) : null
    if (s) seen.set(`${s.kind}:${s.slug}`, s)
  }
  return [...seen.values()]
}

// Upsert: a slug already stored keeps its first source and first_seen; returns how many were new.
export function addBoards(db: Database.Database, boards: readonly { kind: AtsKind; slug: string }[], source: string, now = Date.now()): number {
  const ins = db.prepare('INSERT INTO ats_boards (kind, slug, source, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT (kind, slug) DO NOTHING')
  let added = 0
  db.transaction(() => { for (const b of boards) added += ins.run(b.kind, b.slug, source.slice(0, 80), now).changes })()
  return added
}

// Fallback seed (PM 2026-11-22, while Common Crawl is down): the ATS boards of leads already stored, labelled 'past_leads'.
export function seedFromPastLeads(db: Database.Database, now = Date.now()): number {
  const rows = db.prepare("SELECT DISTINCT source_url FROM leads WHERE source_url LIKE 'https://jobs.ashbyhq.com/%' OR source_url LIKE 'https://boards.greenhouse.io/%' OR source_url LIKE 'https://job-boards.greenhouse.io/%' OR source_url LIKE 'https://jobs.lever.co/%'").all() as { source_url: string }[]
  return addBoards(db, rows.map(r => boardSlugOf(r.source_url)).filter((s): s is { kind: AtsKind; slug: string } => !!s), 'past_leads', now)
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
// Common Crawl's free index, read as files (data.commoncrawl.org): the CDX query server (index.commoncrawl.org) answered 504 /
// circuit-breaker on 2026-11-22, while the same index's files are served from the open-data bucket. cluster.idx (sorted by SURT key)
// names each ~3,000-line block of the cdx-*.gz shards; a board host's captures sit in the block before its first key and the blocks
// that start with it. One block is a ~300 KB range read, gunzipped.
const DATA = 'https://data.commoncrawl.org'
// The four board hosts as SURT keys (host labels reversed), the same hosts as the URL patterns jobs.ashbyhq.com/* etc.
export const CDX_PATTERNS = ['jobs.ashbyhq.com/*', 'boards.greenhouse.io/*', 'job-boards.greenhouse.io/*', 'jobs.lever.co/*'] as const
export const surtOf = (pattern: string): string => `${pattern.replace(/\/\*$/, '').split('.').reverse().join(',')})/`
export interface IdxBlock { file: string; offset: number; length: number }
const blockOf = (line: string): IdxBlock | null => {
  const [, file, off, len] = line.split('\t')
  return file && /^cdx-\d{5}\.gz$/.test(file) && /^\d+$/.test(off ?? '') && /^\d+$/.test(len ?? '') ? { file, offset: Number(off), length: Number(len) } : null
}
// From sorted cluster.idx lines: the block before the first key under `surt`, then every block whose first key is under it.
export function blocksFor(lines: readonly string[], surt: string): IdxBlock[] {
  const out: IdxBlock[] = []
  let prev: string | null = null
  for (const l of lines) {
    const key = l.split(' ')[0] ?? ''
    if (key.startsWith(surt)) { if (out.length === 0 && prev) { const b = blockOf(prev); if (b) out.push(b) } const b = blockOf(l); if (b) out.push(b) }
    else if (key > surt) { if (out.length === 0 && prev) { const b = blockOf(prev); if (b) out.push(b) } break }
    prev = l
  }
  const seen = new Set<string>()
  return out.filter(b => { const k = `${b.file}:${b.offset}`; if (seen.has(k)) return false; seen.add(k); return true })
}
async function rangeText(fetchImpl: Fetch, url: string, from: number, to: number): Promise<string> {
  const r = await fetchImpl(url, { headers: { Range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(60_000) })
  if (r.status !== 206 && r.status !== 200) throw new Error(`range ${r.status}`)
  return r.text()
}
// The cluster.idx lines around `surt`, found by binary search over byte ranges (the file is ~100 MB; this reads ~30 small windows).
export async function idxLinesFor(fetchImpl: Fetch, crawl: string, surt: string): Promise<string[]> {
  const url = `${DATA}/cc-index/collections/${crawl}/indexes/cluster.idx`
  const head = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
  const size = Number(head.headers.get('content-length'))
  if (!head.ok || !Number.isFinite(size) || size <= 0) throw new Error(`cluster.idx ${head.status}`)
  const W = 16_384
  const firstKeyAt = async (pos: number): Promise<{ key: string; start: number } | null> => {
    const txt = await rangeText(fetchImpl, url, pos, Math.min(size - 1, pos + W))
    const nl = pos === 0 ? -1 : txt.indexOf('\n'); if (pos > 0 && nl < 0) return null
    const line = txt.slice(nl + 1).split('\n')[0]; return line ? { key: line.split(' ')[0], start: pos + nl + 1 } : null
  }
  let lo = 0, hi = size
  while (hi - lo > W) { const mid = Math.floor((lo + hi) / 2); const k = await firstKeyAt(mid); if (!k || k.key >= surt) hi = mid; else lo = mid }
  // read forward from lo until a key past the host's keys
  const lines: string[] = []
  for (let pos = lo, rest = ''; pos < size; pos += W + 1) {
    const txt = rest + await rangeText(fetchImpl, url, pos, Math.min(size - 1, pos + W))
    const parts = txt.split('\n'); rest = parts.pop() ?? ''
    const done = parts.some(l => { const k = l.split(' ')[0] ?? ''; return k > surt && !k.startsWith(surt) })
    lines.push(...parts)
    if (done) return lines.filter((l, i) => i > 0 || lo === 0)
  }
  if (rest) lines.push(rest)
  return lines.filter((l, i) => i > 0 || lo === 0)
}

// The newest crawls, from Common Crawl's own list, newest first.
export async function latestCrawls(fetchImpl: Fetch, n = 2): Promise<string[]> {
  const r = await fetchImpl(`${DATA}/crawl-data/index.html`, { signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`crawl list ${r.status}`)
  const ids = [...new Set((await r.text()).match(/CC-MAIN-\d{4}-\d{2}/g) ?? [])].sort().reverse()
  return ids.slice(0, n)
}

// One step of discovery: the next unread block of one (crawl, pattern), resumable from its cursor. Returns null when that pattern is
// done. A failure throws; the caller backs off and the cursor stays put.
export async function discoverStep(db: Database.Database, fetchImpl: Fetch, crawl: string, pattern: string, now = Date.now()): Promise<{ page: number; pages: number; added: number } | null> {
  const cur = db.prepare('SELECT pages, next_page FROM ats_index_cursor WHERE crawl = ? AND pattern = ?').get(crawl, pattern) as { pages: number | null; next_page: number } | undefined
  if (cur && cur.pages !== null && cur.next_page >= cur.pages) return null
  const blocks = blocksFor(await idxLinesFor(fetchImpl, crawl, surtOf(pattern)), surtOf(pattern))
  db.prepare('INSERT INTO ats_index_cursor (crawl, pattern, pages, next_page, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (crawl, pattern) DO UPDATE SET pages = excluded.pages, updated_at = excluded.updated_at').run(crawl, pattern, blocks.length, now)
  const page = cur?.next_page ?? 0
  if (page >= blocks.length) return null
  const b = blocks[page]
  const r = await fetchImpl(`${DATA}/cc-index/collections/${crawl}/indexes/${b.file}`, { headers: { Range: `bytes=${b.offset}-${b.offset + b.length - 1}` }, signal: AbortSignal.timeout(120_000) })
  if (r.status !== 206 && r.status !== 200) throw new Error(`cdx block ${r.status}`)
  const { gunzipSync } = await import('node:zlib')
  const added = addBoards(db, slugsFromCdx(gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8')), `commoncrawl:${crawl}`, now)
  db.prepare('UPDATE ats_index_cursor SET next_page = ?, updated_at = ? WHERE crawl = ? AND pattern = ?').run(page + 1, now, crawl, pattern)
  return { page, pages: blocks.length, added }
}
