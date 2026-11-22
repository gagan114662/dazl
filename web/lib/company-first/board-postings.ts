// Company-first signal proof by ATS board slug (ported from the company-first runner prototype, stage 3 "fresh_board_match").
// An admitted search result on a public ATS board (boards.greenhouse.io/<org>, jobs.lever.co/<org>, jobs.ashbyhq.com/<org>)
// names the employer's board. The board's free public JSON lists every open role with the board's own first-published day.
// For each board, the newest role whose title matches the request's own terms and whose day is inside the request window is
// returned as its posting URL. Nothing is decided here: the posting is then read like any publisher page (the verifier
// reads it from the board record, dates it by that record, and every existing identity, place and hiring hold applies).
import type { SafeGet } from '../sources/types.ts'
import { looksLikeHtml } from '../sources/types.ts'
import { boardApi, boardOf, boardRoles, type Board } from '../sources/ats-board-api.ts'
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
  // and each role's board title (same key), for the requested-role order
  titles?: Map<string, string>
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
      { const k = postingKey(r.url); if (k && r.posted) { o.dates?.set(k, r.posted); if (r.title) o.titles?.set(k, r.title) } }
      if (r.posted > today || (since && r.posted < since) || !atsPostingRef(r.url)) continue
      if (!isGtmRole(r.title) || NOT_A_SALES_HIRE.test(r.title)) continue
      const hits = words(r.title).filter(w => terms.has(w)).length
      if (hits) ranked.push({ url: r.url, hits, posted: r.posted })
    }
    picks.push(...ranked.sort((a, b) => b.hits - a.hits || (a.posted < b.posted ? 1 : -1)).slice(0, PER_BOARD))
  }
  return picks.sort((a, b) => b.hits - a.hits || (a.posted < b.posted ? 1 : -1)).slice(0, MAX_POSTINGS_PER_ANGLE).map(p => p.url)
}

// Run af02437c (39 boards cited, 2 read): the pick step above reads at most 8 boards on what is left of the phase, so a posting whose
// board came later (or any posting once the phase was short) reached the read slots undated. Dating is its own step: every board behind
// an ATS posting URL that could take a slot is read once, in parallel, on its own small deadline, only to fill dates/titles. It picks
// nothing. The counts and the cause go to the run report.
export type BoardDating = { boards: number; read: number; failed: number; cause: 'none' | 'deadline' | 'unreadable' | 'no_boards' }
// Qodo #1552: deadlineMs is each board's own deadline, started when a worker takes it; totalMs (default deadlineMs) caps the whole step.
export async function dateBoards(urls: string[], o: { http: SafeGet; deadlineMs: number; totalMs?: number; clock?: () => number; concurrency?: number; dates?: Map<string, string>; titles?: Map<string, string> }): Promise<BoardDating> {
  const clock = o.clock ?? Date.now, deadline = clock() + Math.max(0, o.totalMs ?? o.deadlineMs)
  const boards = new Map<string, Board>()
  for (const u of urls) { if (!atsPostingRef(u)) continue; const b = boardOf(u); if (b && !b.host && !boards.has(`${b.ats}:${b.token}`)) boards.set(`${b.ats}:${b.token}`, b) }
  if (!boards.size) return { boards: 0, read: 0, failed: 0, cause: 'no_boards' }
  const queue = [...boards.values()]
  let read = 0, failed = 0, late = false
  const one = async (b: Board) => {
    if (clock() >= deadline) { late = true; return }
    const own = Math.min(clock() + Math.max(0, o.deadlineMs), deadline)
    const res = await o.http(boardApi(b), { accept: 'application/json', signal: AbortSignal.timeout(Math.max(1, own - clock())) }).catch(() => null)
    let roles: ReturnType<typeof boardRoles> = null
    if (res && res.status === 200 && !res.truncated && !looksLikeHtml(res.body)) { try { roles = boardRoles(b, JSON.parse(res.body)) } catch { roles = null } }
    if (!roles) { if (clock() >= own) late = true; return }
    read++
    for (const r of roles) { const k = postingKey(r.url); if (k && r.posted) { o.dates?.set(k, r.posted); if (r.title) o.titles?.set(k, r.title) } }
  }
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 6, queue.length) }, async () => { for (let b = queue.shift(); b; b = queue.shift()) await one(b) }))
  failed = boards.size - read   // Qodo #1552: a board skipped at the deadline or timed out is not dated either; never reported as zero
  return { boards: boards.size, read, failed, cause: read === boards.size ? 'none' : late ? 'deadline' : 'unreadable' }
}

// One key for a posting across its URL shapes (boards. / job-boards., /application, /apply).
export function postingKey(url: string): string | null {
  const r = atsPostingRef(url)
  return r ? `${r.kind}:${r.org.toLowerCase()}:${r.id}` : null
}
// #1122 discovery volume: the read slots are capped (5 per angle). A posting whose board record dates it outside the window (or in the
// future) is dropped BEFORE the cap, and dated in-window postings take the first slots, newest first. Anything the board did not date
// keeps its order after them and is dated by the verifier as before. The window is never widened.
// Qodo #1548: among the in-window ones, a posting whose board title is a requested role (roleMatch: the hiring gate's own matcher over the
// request's roles) goes first, newest first; other in-window roles follow, newest first; undated URLs last.
// Qodo #1552: undated ATS postings go last only when boardsDated says the dating step ran; otherwise they keep their order.
export function orderByBoardDate(urls: string[], dates: ReadonlyMap<string, string>, o: { windowDays: number | null; now: Date; titles?: ReadonlyMap<string, string>; roleMatch?: (title: string) => boolean; boardsDated?: boolean }): string[] {
  const since = o.windowDays && o.windowDays > 0 ? new Date(o.now.getTime() - o.windowDays * 86_400_000).toISOString().slice(0, 10) : null
  const today = o.now.toISOString().slice(0, 10)
  const dated: { url: string; posted: string; i: number; req: boolean }[] = [], rest: string[] = [], undatedAts: string[] = []
  urls.forEach((url, i) => {
    const k = postingKey(url), posted = k ? dates.get(k) : undefined
    // af02437c: an ATS posting its board did not date (board unread) goes after every other source; the verifier still dates it
    if (!posted) { (k && o.boardsDated ? undatedAts : rest).push(url); return }
    if (posted > today || (since && posted < since)) return
    const title = k ? o.titles?.get(k) : undefined
    dated.push({ url, posted, i, req: !!(title && o.roleMatch?.(title)) })
  })
  return [...dated.sort((a, b) => Number(b.req) - Number(a.req) || (a.posted < b.posted ? 1 : a.posted > b.posted ? -1 : a.i - b.i)).map(d => d.url), ...rest, ...undatedAts]
}
