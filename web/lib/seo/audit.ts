import type Database from 'better-sqlite3'

// Indexing audit: fetches the user's own homepage directly (not via Jina Reader - Jina
// returns markdown, which strips the meta description and canonical tag this audit checks),
// plus robots.txt and the sitemap, and reports the basics a search engine needs. No LLM,
// no key, no third-party call: one page plus two well-known files on the audited domain.
export function migrateSeo(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS seo_audits (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, domain TEXT NOT NULL,
    results TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  );`)
}

export interface AuditCheck { id: string; label: string; ok: boolean; value: string; hint: string }
export interface AuditResult { domain: string; final_url: string; fetched_at: number; checks: AuditCheck[]; error?: string }

// Hostname only: no scheme, path, port, credentials, or trailing dot. http is upgraded to https.
export function normalizeDomain(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[\/?#]/)[0].replace(/\.$/, '')
  if (!/^(localhost|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/.test(s)) return null
  if (s.length > 253) return null
  return s
}

const text = (html: string, re: RegExp) => html.match(re)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

export function parseHomepage(html: string): { title: string; description: string; h1s: string[]; canonical: string } {
  const head = html.slice(0, 200_000)
  const title = unescape(text(head, /<title[^>]*>([\s\S]*?)<\/title>/i)).slice(0, 300)
  const descTag = head.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0] ?? head.match(/<meta[^>]+content=["'][^"']*["'][^>]+name=["']description["'][^>]*>/i)?.[0] ?? ''
  const description = unescape(descTag.match(/content=["']([\s\S]*?)["']/i)?.[1]?.trim() ?? '').slice(0, 500)
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => unescape(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200)).filter(Boolean).slice(0, 10)
  const canonTag = head.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0] ?? ''
  const canonical = canonTag.match(/href=["']([^"']+)["']/i)?.[1]?.trim() ?? ''
  return { title, description, h1s, canonical }
}

export function parseRobots(txt: string): { blocksAll: boolean; sitemaps: string[] } {
  const sitemaps = [...txt.matchAll(/^sitemap:\s*(\S+)\s*$/gim)].map(m => m[1]).slice(0, 10)
  // Blocks everything when a User-agent: * group carries a bare "Disallow: /".
  let blocksAll = false
  let star = false
  for (const line of txt.split(/\r?\n/)) {
    const l = line.trim()
    if (/^user-agent:\s*\S+/i.test(l)) star = /^user-agent:\s*\*\s*$/i.test(l)
    else if (star && /^disallow:\s*\/\s*$/i.test(l)) blocksAll = true
  }
  return { blocksAll, sitemaps }
}

async function get(url: string, f: typeof fetch, cap: number): Promise<{ ok: boolean; status: number; body: string; finalUrl: string }> {
  try {
    const res = await f(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'dazl-indexing-audit/1.0', accept: 'text/html,text/plain,application/xml;q=0.9,*/*;q=0.5' } })
    const body = (await res.text()).slice(0, cap)
    return { ok: res.ok, status: res.status, body, finalUrl: res.url }
  } catch { return { ok: false, status: 0, body: '', finalUrl: url } }
}

export async function runAudit(db: Database.Database, tenantId: string, rawDomain: string, deps: { fetchImpl?: typeof fetch; now?: number; id?: string } = {}): Promise<AuditResult | { error: string }> {
  const domain = normalizeDomain(rawDomain)
  if (!domain) return { error: 'Enter a domain like acme.com (no https://, no path).' }
  const f = deps.fetchImpl ?? fetch
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const checks: AuditCheck[] = []
  const home = await get(`https://${domain}/`, f, 1_000_000)
  if (!home.ok && home.status === 0) return { error: `Could not reach https://${domain}/ - check the domain and that the site is up.` }
  const robots = await get(`https://${domain}/robots.txt`, f, 200_000)
  const rb = robots.ok ? parseRobots(robots.body) : null

  if (!home.ok) {
    checks.push({ id: 'reachable', label: 'Homepage loads', ok: false, value: `HTTP ${home.status}`, hint: 'The homepage must return 200 for search engines to index it.' })
  } else {
    const p = parseHomepage(home.body)
    checks.push({ id: 'reachable', label: 'Homepage loads', ok: true, value: `HTTP ${home.status}${home.finalUrl !== `https://${domain}/` ? ` (redirects to ${home.finalUrl})` : ''}`, hint: '' })
    checks.push({ id: 'title', label: 'Title tag', ok: p.title.length >= 10 && p.title.length <= 70, value: p.title ? `"${p.title}" (${p.title.length} chars)` : 'missing', hint: p.title ? 'Keep it 10-70 characters, main keyword near the front.' : 'Add a unique <title> - it is the headline in search results.' })
    checks.push({ id: 'meta_description', label: 'Meta description', ok: p.description.length >= 50 && p.description.length <= 320, value: p.description ? `"${p.description.slice(0, 120)}${p.description.length > 120 ? '…' : ''}" (${p.description.length} chars)` : 'missing', hint: p.description ? 'Keep it 50-320 characters; it is the snippet under the title.' : 'Add a meta description - it is the snippet under your title in search results.' })
    checks.push({ id: 'h1', label: 'Exactly one H1', ok: p.h1s.length === 1, value: p.h1s.length === 0 ? 'missing' : p.h1s.length === 1 ? `"${p.h1s[0]}"` : `${p.h1s.length} H1 tags found`, hint: p.h1s.length === 1 ? '' : 'One clear H1 per page telling search engines what the page is about.' })
    checks.push({ id: 'canonical', label: 'Canonical link', ok: /^https:\/\//.test(p.canonical), value: p.canonical || 'missing', hint: p.canonical ? '' : 'Add <link rel="canonical"> so search engines know the one true URL for the page.' })
  }
  checks.push({ id: 'robots', label: 'robots.txt', ok: !!rb && !rb.blocksAll, value: !rb ? (robots.status === 404 ? 'not found (everything is allowed)' : `HTTP ${robots.status}`) : rb.blocksAll ? 'blocks ALL crawlers' : 'present, crawling allowed', hint: !rb ? 'Optional, but a robots.txt lets you point crawlers at your sitemap.' : rb.blocksAll ? 'Fix this first: "Disallow: /" for * tells every search engine to ignore the whole site.' : '' })
  const sitemapOk = rb && rb.sitemaps.length > 0 ? { found: true, where: rb.sitemaps[0] } : null
  let sitemapValue = '', sitemapFound = false
  if (sitemapOk) { sitemapFound = true; sitemapValue = `declared in robots.txt: ${sitemapOk.where}` } else {
    const sm = await get(`https://${domain}/sitemap.xml`, f, 50_000)
    if (sm.ok && /<(urlset|sitemapindex)[\s>]/i.test(sm.body)) { sitemapFound = true; sitemapValue = '/sitemap.xml exists' } else sitemapValue = 'not found'
  }
  checks.push({ id: 'sitemap', label: 'Sitemap', ok: sitemapFound, value: sitemapValue, hint: sitemapFound ? '' : 'Add an XML sitemap and reference it from robots.txt so crawlers find every page.' })

  const result: AuditResult = { domain, final_url: home.finalUrl, fetched_at: now, checks }
  db.prepare('INSERT INTO seo_audits (id, tenant_id, domain, results) VALUES (?, ?, ?, ?)').run(deps.id ?? `${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`, tenantId, domain, JSON.stringify(result))
  return result
}

export function recentAudits(db: Database.Database, tenantId: string, limit = 10): { id: string; domain: string; results: AuditResult; created_at: number }[] {
  return (db.prepare('SELECT id, domain, results, created_at FROM seo_audits WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit) as { id: string; domain: string; results: string; created_at: number }[])
    .map(r => ({ ...r, results: JSON.parse(r.results) as AuditResult }))
}
