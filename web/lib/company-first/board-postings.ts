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

export const MAX_BOARDS_PER_ANGLE = 8, MAX_POSTINGS_PER_ANGLE = 3

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export async function freshBoardPostings(admittedUrls: string[], o: {
  terms: string[]; windowDays: number | null; now: Date; http: SafeGet; deadlineMs?: number; clock?: () => number
}): Promise<string[]> {
  const clock = o.clock ?? Date.now, deadline = clock() + Math.max(0, o.deadlineMs ?? 15_000)
  const terms = new Set(o.terms.map(t => t.toLowerCase()))
  if (!terms.size) return []
  const boards = new Map<string, Board>()
  for (const u of admittedUrls) { const b = boardOf(u); if (b && !boards.has(`${b.ats}:${b.token}`)) boards.set(`${b.ats}:${b.token}`, b) }
  // With no window there is no freshness to prove: the posting still goes through the normal verifier, so take the newest.
  const since = o.windowDays && o.windowDays > 0 ? new Date(o.now.getTime() - o.windowDays * 86_400_000).toISOString().slice(0, 10) : null
  const today = o.now.toISOString().slice(0, 10)
  const picks: { url: string; hits: number; posted: string }[] = []
  for (const b of [...boards.values()].slice(0, MAX_BOARDS_PER_ANGLE)) {
    if (clock() >= deadline) break
    const res = await o.http(boardApi(b), { accept: 'application/json' }).catch(() => null)
    if (!res || res.status !== 200 || res.truncated || looksLikeHtml(res.body)) continue
    let body: unknown
    try { body = JSON.parse(res.body) } catch { continue }
    const roles = boardRoles(b, body)
    if (!roles) continue
    let best: { url: string; hits: number; posted: string } | null = null
    for (const r of roles) {
      if (r.posted > today || (since && r.posted < since) || !atsPostingRef(r.url)) continue
      const hits = words(r.title).filter(w => terms.has(w)).length
      if (!hits) continue
      if (!best || hits > best.hits || (hits === best.hits && r.posted > best.posted)) best = { url: r.url, hits, posted: r.posted }
    }
    if (best) picks.push(best)
  }
  return picks.sort((a, b) => b.hits - a.hits || (a.posted < b.posted ? 1 : -1)).slice(0, MAX_POSTINGS_PER_ANGLE).map(p => p.url)
}
