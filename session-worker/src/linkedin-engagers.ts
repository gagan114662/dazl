// LinkedIn post engagers (#192, owner-authorised 2026-11-06): the commenters or the reactors of ONE post, read through the
// session cookie the app sends (the designated throwaway account's session, held only in the app's encrypted connector
// store). Read-only: this module never reacts, comments, messages, connects or posts. One call = exactly ONE upstream GET
// (one page, no pagination, no retry). A login wall, a checkpoint / captcha or a rate-limit answer is reported as that
// failure (auth_failed / challenge / throttled), never as an empty list. Nothing is stored and no cookie is logged.
import { epochDay, FetchFailure, latinRun, type FailureKind, type WorkerItem } from './util.ts'
import { checkLinkedin } from './fetchers.ts'

export type EngagerKind = 'commenters' | 'reactors'
export const isEngagerKind = (v: unknown): v is EngagerKind => v === 'commenters' || v === 'reactors'
export const MAX_ENGAGERS = 25

// The post's activity id from a feed URL or an activity URN. Anything else is not a post this module reads.
export function activityId(post: string): string | null {
  const m = post.match(/(?:urn:li:activity:|activity[:-])(\d{10,25})/)
  return m ? m[1] : null
}

export function engagersUrl(kind: EngagerKind, id: string): string {
  return kind === 'commenters'
    ? `https://www.linkedin.com/voyager/api/feed/comments?count=${MAX_ENGAGERS}&q=comments&sortOrder=RELEVANCE&start=0&updateId=activity:${id}`
    : `https://www.linkedin.com/voyager/api/voyagerSocialDashReactions?count=${MAX_ENGAGERS}&q=reactionType&start=0&threadUrn=${encodeURIComponent(`urn:li:activity:${id}`)}`
}

// What an answer that is NOT a usable JSON page means. LinkedIn answers a signed-out or flagged session with a redirect
// (to /login, /authwall or /checkpoint/challenge), a 999 bot block, a 429, or an HTML page in place of JSON.
const CHALLENGE = /checkpoint|challenge|captcha|security-verification/i
const LOGIN = /\/login|authwall|\/uas\/|signup|sign in to|join linkedin/i
export function classifyAnswer(status: number, location: string | null, text: string): FailureKind | null {
  if (status >= 300 && status < 400) return location && CHALLENGE.test(location) ? 'challenge' : location && LOGIN.test(location) ? 'auth_failed' : 'upstream_error'
  if (status === 999) return 'challenge'
  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 429) return 'throttled'
  if (status < 200 || status > 299) return 'upstream_error'
  if (/^\s*</.test(text)) return CHALLENGE.test(text) ? 'challenge' : LOGIN.test(text) ? 'auth_failed' : 'schema_error'
  return null
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const textOf = (v: unknown): string => str(obj(v)?.text) || str(obj(obj(v)?.text)?.text)
const SLUG = /^[A-Za-z0-9%_-]{2,100}$/
const PROFILE_URL = /^https:\/\/www\.linkedin\.com\/in\/([A-Za-z0-9%_-]{2,100})\/?(?:[?#].*)?$/

interface Person { slug: string; name: string; headline: string }
// Every profile entity in a normalized voyager answer, by each URN it is known under.
function people(included: unknown[]): Map<string, Person> {
  const byUrn = new Map<string, Person>()
  for (const e of included) {
    const o = obj(e); if (!o) continue
    const slug = str(o.publicIdentifier); if (!SLUG.test(slug)) continue
    const p = { slug, name: latinRun(`${str(o.firstName)} ${str(o.lastName)}`).slice(0, 80), headline: latinRun(str(o.occupation) || str(o.headline) || textOf(o.headline)).slice(0, 160) }
    for (const k of ['entityUrn', 'objectUrn', 'dashEntityUrn', '$id']) { const u = str(o[k]); if (u) byUrn.set(u, p) }
  }
  return byUrn
}
// The first profile a (comment / reaction) entity points at: any URN string inside it, depth-bounded.
function referenced(v: unknown, byUrn: Map<string, Person>, depth = 0): Person | null {
  if (depth > 6 || v === null || typeof v !== 'object') return typeof v === 'string' ? byUrn.get(v) ?? null : null
  for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
    const hit = typeof x === 'string' ? byUrn.get(x) ?? null : referenced(x, byUrn, depth + 1)
    if (hit) return hit
  }
  return null
}

// One page of engagers -> profile items. url = the public profile; title = name (and headline); quote = the person's own
// comment, or for a reactor what they did and their headline; the post link stays in the quote so every lead keeps its source.
export function parseEngagers(kind: EngagerKind, raw: unknown, postId: string): WorkerItem[] {
  checkLinkedin(raw)
  const o = obj(raw)!
  const included: unknown[] = Array.isArray(o.included) ? o.included : []
  const byUrn = people(included)
  const post = `https://www.linkedin.com/feed/update/urn:li:activity:${postId}/`
  const out: WorkerItem[] = [], seen = new Set<string>()
  const push = (p: Person, quote: string, date: string | null) => {
    const key = p.slug.toLowerCase(); if (seen.has(key) || out.length >= MAX_ENGAGERS) return
    const q = latinRun(quote).slice(0, 300); if (q.length < 20) return
    seen.add(key)
    out.push({ url: `https://www.linkedin.com/in/${p.slug}`, title: (p.headline ? `${p.name} - ${p.headline}` : p.name || p.slug).slice(0, 120), quote: q, date, login_walled: true })
  }
  for (const e of included) {
    const x = obj(e); if (!x || str(x.publicIdentifier)) continue
    if (kind === 'commenters') {
      const said = textOf(x.commentV2) || textOf(x.commentary) || textOf(x.comment)
      if (!said) continue
      const p = referenced(x.commenter ?? x['*commenter'] ?? x.commenterForDashConversion ?? x, byUrn); if (!p) continue
      push(p, `Commented on ${post}: "${said}"`, epochDay(x.createdAt ?? x.createdTime))
    } else {
      const lockup = obj(x.reactorLockup)
      const nav = str(lockup?.navigationUrl).match(PROFILE_URL)?.[1]
      const p = nav ? { slug: nav, name: latinRun(textOf(lockup?.title)).slice(0, 80), headline: latinRun(textOf(lockup?.subtitle)).slice(0, 160) } : str(x.reactionType) ? referenced(x.actor ?? x['*actor'] ?? x.actorUrn ?? x, byUrn) : null
      if (!p) continue
      push(p, `Reacted (${str(x.reactionType).toLowerCase() || 'like'}) to ${post}${p.headline ? `. Headline: ${p.headline}` : ''}`, null)
    }
  }
  return out
}

// The one upstream GET. Manual redirects so a login wall / checkpoint is seen for what it is; 15s cap; 1MB body cap.
export async function fetchEngagers(kind: EngagerKind, post: string, session: string): Promise<WorkerItem[]> {
  const id = activityId(post); if (!id) throw new FetchFailure('schema_error')
  const liAt = session.match(/li_at=([^;]+)/)?.[1]
  const jsession = session.match(/JSESSIONID="?([^";]+)"?/)?.[1]
  if (!liAt || !jsession) throw new FetchFailure('auth_failed')
  let res: Response
  try {
    res = await fetch(engagersUrl(kind, id), {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'application/vnd.linkedin.normalized+json+2.1', cookie: `li_at=${liAt}; JSESSIONID="${jsession}"`,
        'csrf-token': jsession, 'x-restli-protocol-version': '2.0.0', referer: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
  } catch { throw new FetchFailure('upstream_error') }
  let text = ''
  try { text = await res.text() } catch { throw new FetchFailure('upstream_error') }
  const bad = classifyAnswer(res.status, res.headers.get('location'), text.slice(0, 20_000))
  if (bad) throw new FetchFailure(bad)
  if (text.length > 1_000_000) throw new FetchFailure('schema_error')
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new FetchFailure('schema_error') }
  return parseEngagers(kind, json, id)
}
