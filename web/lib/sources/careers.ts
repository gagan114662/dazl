// First-party careers source (#388 / #767): an open sales / GTM role on a company's OWN careers page, as a source adapter. The page reading is
// lib/signals/careers-page.ts (robots.txt obeyed, same registrable domain, the job's own page re-fetched and proven open, role read from the posting
// itself, closed wording and non-job "apply" links rejected). This file only decides WHICH sites to read and turns a verified vacancy into Evidence.
//  - Sites come from what the scan was GIVEN: the company websites / careers URLs the user listed (input.pages) and companies that carry a domain
//    (input.companies). A domain is never guessed from a company name here, so the identity of the site is whatever the user / scan already established.
//  - Evidence cites the specific job URL. Its date is the Greenhouse / Lever / Ashby publish date when the careers link is a public ATS posting, and null
//    otherwise: an own-domain job page does not date itself and the retrieval day is never used in its place.
//  - Only sales / GTM roles are read (what the careers reader can prove). A request that names no sales role, or a scan with no company site, is reported as
//    out of coverage - never as an empty market. An unreachable robots.txt / page / posting is a partial result, never "no vacancy".
import { careersSalesVacancy } from '../signals/careers-page.ts'
import type { Get } from '../connectors/sitecrawl.ts'
import type { AdapterInput, Evidence, SafeGet, SourceAdapter } from './types.ts'

// Per scan: at most maxSites sites, no request STARTS after budgetMs (each is hard-bounded at 10 s by the guarded getter, so 12 + 10 < the 25 s adapter deadline).
export const careersLimits = { budgetMs: 12_000, maxSites: 4, now: () => Date.now() }
// A bare "revenue" ("companies with revenue growth") is not a sales-role ask: only revenue ROLE phrasing counts.
export const SALES_ASK = /\b(?:sales|account executives?|sdrs?|bdrs?|business development|go-to-market|gtm|chief revenue officers?|(?:head|vp|vice president|director)s? of revenue|revenue (?:roles?|team|teams|hires?|hiring|leaders?|leadership|officers?|ops|operations|positions?|jobs?))\b/i

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
// A bare domain or an https URL -> its host, or null. Never an IP, a userinfo URL, a port or a non-https scheme.
export function siteOf(raw: string): string | null {
  const s = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https:\/\//i.test(s)) return null
  let u: URL; try { u = new URL(/^https:\/\//i.test(s) ? s : `https://${s}`) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  return HOST.test(host) && !/^\d+(?:\.\d+){3}$/.test(host) && /[a-z]{2,}$/.test(host) ? host : null
}

const bare = (h: string) => h.toLowerCase().replace(/^www\./, '')
const sameSite = (a: string, b: string) => { const x = bare(a), y = bare(b); return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`) }

export const careersAdapter: SourceAdapter = {
  id: 'careers',
  label: 'Company careers pages (first party)',
  async collect({ query, pages, companies, http, note }: AdapterInput): Promise<Evidence[]> {
    if (!SALES_ASK.test(query)) { note?.('out_of_coverage'); return [] }
    const sites = new Map<string, string | undefined>() // host -> company name when known
    for (const c of companies ?? []) { const s = c.domain ? siteOf(c.domain) : null; if (s && !sites.has(s)) sites.set(s, c.name) }
    for (const p of pages ?? []) { const s = siteOf(p); if (s && !sites.has(s)) sites.set(s, undefined) }
    if (sites.size === 0) { note?.('out_of_coverage'); return [] }
    const t0 = careersLimits.now()
    let failed = false
    const get = (raw: SafeGet): Get => async (url, o) => {
      if (careersLimits.now() - t0 > careersLimits.budgetMs) { note?.('budget'); failed = true; return null }
      if (o?.signal?.aborted) { failed = true; return null }
      // The getter does not follow redirects, so a same-site https redirect (apex -> www, /careers -> /careers/) is followed here, at most twice. An off-site hop is
      // returned as that site's (empty) page so the careers reader reports wrong_domain; a failed request or an unfollowable redirect is unreadable, not "no vacancy".
      let at = url
      for (let hop = 0; hop <= 2; hop++) {
        const r = await raw(at, { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5' })
        if (!r || r.status === 0) break
        if (r.status < 300 || r.status >= 400) return { status: r.status, body: r.body, finalUrl: at }
        let next: URL; try { next = new URL(r.location ?? '', at) } catch { break }
        if (next.protocol !== 'https:' || next.username || next.password) break
        if (!sameSite(next.hostname, new URL(at).hostname)) return /\/robots\.txt$/.test(new URL(url).pathname) ? (failed = true, null) : { status: 200, body: '', finalUrl: next.toString() }
        at = next.toString()
      }
      failed = true
      return null
    }
    const out: Evidence[] = []
    let n = 0
    for (const [site, company] of sites) {
      if (n++ >= careersLimits.maxSites) { note?.('site_cap'); break }
      failed = false
      let res: Awaited<ReturnType<typeof careersSalesVacancy>>
      try { res = await careersSalesVacancy(site, get(http), { company, now: careersLimits.now() }) } catch { note?.('site_error'); continue }
      const v = res.vacancy
      if (v && res.reason === 'found') {
        if (v.quote.length < 20) { note?.('quote_too_short'); continue } // evidence needs a 20-300 character passage from the page; a bare title is not one
        out.push({ source: 'careers', url: v.url, title: `${v.title} - ${site}`.slice(0, 200), quote: v.quote.slice(0, 300), date: v.posted && /^\d{4}-\d{2}-\d{2}$/.test(v.posted) ? v.posted : null })
      } else if (failed || res.reason === 'robots_unreachable' || res.reason === 'job_unverified') note?.('unreachable') // a read that failed says nothing about hiring
    }
    return out
  },
}
