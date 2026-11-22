// Company-first signal proof by ATS board slug (ported from the company-first runner prototype, stage 3 "fresh_board_match").
// An admitted search result on a public ATS board (boards.greenhouse.io/<org>, jobs.lever.co/<org>, jobs.ashbyhq.com/<org>)
// names the employer's board. The board's free public JSON lists every open role with the board's own first-published day.
// For each board, the newest role whose title matches the request's own terms and whose day is inside the request window is
// returned as its posting URL. Nothing is decided here: the posting is then read like any publisher page (the verifier
// reads it from the board record, dates it by that record, and every existing identity, place and hiring hold applies).
import type { SafeGet } from '../sources/types.ts'
import { looksLikeHtml } from '../sources/types.ts'
import { boardApi, boardOf, boardRoles, type Board } from '../research/sources/ats-boards.ts'
import { atsPostingRef } from '../sources/ats-posting.ts'
import { isGtmRole } from '../signals/ats-gtm.ts'

// A role that staffs someone else's sales hiring, or is not a real hire, never stands for the requested sales hire.
const NOT_A_SALES_HIRE = /\b(?:recruit\w*|talent|sourcer|intern(?:ship)?s?|apprentice\w*|trainer|enablement)\b/i

export const MAX_BOARDS_PER_ANGLE = 8, MAX_POSTINGS_PER_ANGLE = 2, PER_BOARD = 2

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export async function freshBoardPostings(admittedUrls: string[], o: {
  terms: string[]; windowDays: number | null; now: Date; http: SafeGet; deadlineMs?: number; clock?: () => number
  // filled with every role's board first-published day (key: postingKey), for orderByBoardDate
  dates?: Map<string, string>
}): Promise<string[]> {
  const clock = o.clock ?? Date.now, deadline = clock() + Math.max(0, o.deadlineMs ?? 15_000)
  const terms = new Set(o.terms.map(t => t.toLowerCase()))
  if (!terms.size) return []
  const boards = new Map<string, Board>()
  // EU-hosted boards are skipped: their posting URLs have no record reader (lib/sources/ats-posting.ts), so none could be dated.
  for (const u of admittedUrls) { const b = boardOf(u); if (b && !b.host && !boards.has(`${b.ats}:${b.token}`)) boards.set(`${b.ats}:${b.token}`, b) }
  // With no window there is no freshness to prove: the posting still goes through the normal verifier, so take the newest.
  const since = o.windowDays && o.windowDays > 0 ? new Date(o.now.getTime() - o.windowDays * 86_400_000).toISOString().slice(0, 10) : null
  const today = o.now.toISOString().slice(0, 10)
  const picks: { url: string; hits: number; posted: string }[] = []
  for (const b of [...boards.values()].slice(0, MAX_BOARDS_PER_ANGLE)) {
    if (clock() >= deadline) break
    const res = await o.http(boardApi(b), { accept: 'application/json', signal: AbortSignal.timeout(Math.max(1, deadline - clock())) }).catch(() => null)
    if (!res || res.status !== 200 || res.truncated || looksLikeHtml(res.body)) continue
    let body: unknown
    try { body = JSON.parse(res.body) } catch { continue }
    const roles = boardRoles(b, body)
    if (!roles) continue
    // The best few matches per board, not one: a top match the verifier then rejects (place, closed, unlisted) must not hide
    // the next in-window role for the requested job on the same board.
    const ranked: { url: string; hits: number; posted: string }[] = []
    for (const r of roles) {
      if (o.dates) { const k = postingKey(r.url); if (k && r.posted) o.dates.set(k, r.posted) }
      if (r.posted > today || (since && r.posted < since) || !atsPostingRef(r.url)) continue
      if (!isGtmRole(r.title) || NOT_A_SALES_HIRE.test(r.title)) continue
      const hits = words(r.title).filter(w => terms.has(w)).length
      if (hits) ranked.push({ url: r.url, hits, posted: r.posted })
    }
    picks.push(...ranked.sort((a, b) => b.hits - a.hits || (a.posted < b.posted ? 1 : -1)).slice(0, PER_BOARD))
  }
  return picks.sort((a, b) => b.hits - a.hits || (a.posted < b.posted ? 1 : -1)).slice(0, MAX_POSTINGS_PER_ANGLE).map(p => p.url)
}

// One key for a posting across its URL shapes (boards. / job-boards., /application, /apply).
export function postingKey(url: string): string | null {
  const r = atsPostingRef(url)
  return r ? `${r.kind}:${r.org.toLowerCase()}:${r.id}` : null
}
// #1122 discovery volume: the read slots are capped (5 per angle). A posting whose board record dates it outside the window (or in the
// future) is dropped BEFORE the cap, and dated in-window postings take the first slots, newest first. Anything the board did not date
// keeps its order after them and is dated by the verifier as before. The window is never widened.
export function orderByBoardDate(urls: string[], dates: ReadonlyMap<string, string>, o: { windowDays: number | null; now: Date }): string[] {
  const since = o.windowDays && o.windowDays > 0 ? new Date(o.now.getTime() - o.windowDays * 86_400_000).toISOString().slice(0, 10) : null
  const today = o.now.toISOString().slice(0, 10)
  const dated: { url: string; posted: string; i: number }[] = [], rest: string[] = []
  urls.forEach((url, i) => {
    const k = postingKey(url), posted = k ? dates.get(k) : undefined
    if (!posted) { rest.push(url); return }
    if (posted > today || (since && posted < since)) return
    dated.push({ url, posted, i })
  })
  return [...dated.sort((a, b) => (a.posted < b.posted ? 1 : a.posted > b.posted ? -1 : a.i - b.i)).map(d => d.url), ...rest]
}
