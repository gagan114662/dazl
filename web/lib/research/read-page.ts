// MISSION v2, part D (Refs #1099): stage 4 of the research engine (LEAD_ENGINE=research), ported from ~/work/proto/ai-research
// (pipeline.py extract()). One opened page -> the named businesses on it that have a buying trigger, each with a VERBATIM quote that proves
// the event, the event day with the verbatim text that states it, where the business is, and the people the page names with their role.
// The model call is injected (`ask`), so the stage is pure and testable on recorded pages; a caller passes the tenant's own key's model.
// Nothing here is trusted: every event is re-checked against the page by verify.ts before anything is stored or shown.
import { quoteOnPage } from './verify.ts'

export interface ReadablePage { url: string; title: string; text: string; metaDates?: string[] }
export interface ReadContext {
  today: string            // YYYY-MM-DD, the scan's own clock
  category: string         // the buyer category asked for, e.g. "Law firms"
  location: string         // e.g. "Chicago, Illinois"
  offer: string            // what the seller sells
  triggers: { id: string; name: string }[]
}
export interface PersonMention { name: string; title: string | null; quote: string }
// One trigger event read off one page. `quote`, `date_quote`, `location_quote` and each person's `quote` are what the model says the page
// says; verify.ts proves each of them on the page text before the event counts.
export interface PageEvent {
  company: string
  website: string | null
  pageIsCompanysOwnSite: boolean
  triggerId: string | null
  whatHappened: string
  whyNow: string
  quote: string
  eventDate: string | null       // YYYY-MM-DD as claimed
  dateQuote: string | null
  locationQuote: string | null
  people: PersonMention[]
  sourceUrl: string
}
export type Ask = (prompt: string, maxTokens: number) => Promise<string>

export const PAGE_TEXT_MAX = 8000   // what the prototype read; enough for a news story or a press release
export const EVENTS_MAX = 8

// The prompt is the prototype's, with the same rules: copy quotes character for character, never invent, no date on the page -> null,
// only people who work at the business, vendors / job boards / directories / the media outlet are not events, services or advice are not
// events.
export function readPrompt(page: ReadablePage, ctx: ReadContext): string {
  const trig = ctx.triggers.map(t => `- ${t.id}: ${t.name}`).join('\n')
  const meta = page.metaDates?.length ? `\nPAGE META DATES: ${page.metaDates.slice(0, 6).join(' | ')}` : ''
  return `Today is ${ctx.today}. We look for ${ctx.category} in ${ctx.location} with a recent buying trigger for a seller of: ${ctx.offer}.
Triggers:
${trig}
PAGE URL: ${page.url}
PAGE TITLE: ${page.title}${meta}
PAGE TEXT:
${page.text.slice(0, PAGE_TEXT_MAX)}
---
List every specific named business ON THIS PAGE that fits (right category, right area) and has a trigger event. Return ONLY JSON:
{"events":[{"company":"exact business name","website":"its domain if shown on the page else null","page_is_companys_own_site":true/false,"trigger_id":"t#","what_happened":"the bare fact in <=15 words","why_now":"one sentence: what happened and why it matters to the seller",
"quote":"VERBATIM sentence (10-40 words) copied from the page text that proves the event","event_date":"YYYY-MM-DD when it happened or was published/posted, else null","date_quote":"VERBATIM text copied from the page that states that date (may be from the PAGE META DATES line), else null",
"location_quote":"VERBATIM text from the page showing where the business is, else null","people":[{"name":"","title":"","quote":"VERBATIM text naming this person with their role at the business"}]}]}
Rules: copy quotes character for character; never invent; no date on the page -> null; only people who work at that business (owner, founder, partner, executive, manager); max ${EVENTS_MAX} events; {"events":[]} if nothing fits. Vendors, job boards, directories and the media outlet itself are not events.
An event is something that CHANGED or is happening now: an open job for a named role, a new location, an expansion, an acquisition or new owner, funding, an award, a new senior hire, a contract win, a product launch, a dated complaint. A page that only describes the services a business sells, or generic advice, is NOT an event: skip it.`
}

// The first JSON object (or array) in a model reply, fences and prose around it ignored. null when there is none.
export function parseJsonReply(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  for (const [a, b] of [['{', '}'], ['[', ']']] as const) {
    const i = t.indexOf(a), k = t.lastIndexOf(b)
    if (i >= 0 && k > i) { try { return JSON.parse(t.slice(i, k + 1)) } catch { /* try the next shape */ } }
  }
  return null
}

const str = (v: unknown, max = 600): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const day = (v: unknown): string | null => { const s = str(v, 10); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null }

// The model's reply -> events. Shape-checked; a field of the wrong type is dropped, never coerced into a claim. An event whose quote is not
// on the page is discarded here already (verify.ts checks again, with the person and date, before anything counts).
export function eventsFromReply(reply: string, page: ReadablePage): PageEvent[] {
  const j = parseJsonReply(reply)
  const raw = j && typeof j === 'object' && !Array.isArray(j) ? (j as { events?: unknown }).events : null
  if (!Array.isArray(raw)) return []
  const out: PageEvent[] = []
  for (const e of raw.slice(0, EVENTS_MAX)) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const company = str(r.company, 160), quote = str(r.quote, 600)
    if (!company || !quote || !quoteOnPage(quote, page.text)) continue
    const people: PersonMention[] = []
    for (const p of Array.isArray(r.people) ? r.people.slice(0, 8) : []) {
      if (!p || typeof p !== 'object') continue
      const q = p as Record<string, unknown>
      const name = str(q.name, 120), pq = str(q.quote, 600)
      if (name && pq) people.push({ name, title: str(q.title, 160), quote: pq })
    }
    out.push({
      company, website: str(r.website, 200), pageIsCompanysOwnSite: r.page_is_companys_own_site === true, triggerId: str(r.trigger_id, 20),
      whatHappened: str(r.what_happened, 200) ?? '', whyNow: str(r.why_now, 400) ?? '', quote,
      eventDate: day(r.event_date), dateQuote: str(r.date_quote, 300), locationQuote: str(r.location_quote, 400), people, sourceUrl: page.url,
    })
  }
  return out
}

export async function readPage(page: ReadablePage, ctx: ReadContext, ask: Ask): Promise<PageEvent[]> {
  if (!page.text.trim()) return []
  return eventsFromReply(await ask(readPrompt(page, ctx), 3000), page)
}
