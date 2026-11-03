// A page's publication day is not the event's day. SYNTHETIC pages through the real runner, verifier, window gate and the draft holds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { currentnessHeld, leadWindowHeld } from '../lib/outreach/currentness.ts'

const REQUEST = 'Find independent dental practices in New York City that opened a new location or posted a front desk receptionist job in the past 90 days.'
const ICP = { summary: 'Independent dental practices in NYC', who: ['Practice manager'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['opened a new location', 'posted a front desk receptionist job'], exclude: [], country: 'US', language: 'en' }
const filler = ' The practice serves families across Manhattan and welcomes new patients every week.'.repeat(6)
function fx(quote: string, text: string, published: string | null, eventDate: string | null = null, url = 'https://news.example/s'): { f: Fixture; c: Cand } {
  const c: Cand = { company: 'Smile Studio', signal: 'dental office event', source_url: url, excerpt: quote, event_date: eventDate }
  return { c, f: { request: REQUEST, modelIcp: ICP, modelQueries: ['dental office opens Manhattan'], hits: [{ url, title: 'Smile Studio', snippet: quote, date: null }], tfPages: {},
    own: { [url]: { title: 'Smile Studio - Manhattan', text: text + filler, ...(published ? { published } : {}) } }, extraction: [c] } }
}
async function held(f: Fixture) {
  const x = await runFixture(f)
  const row = x.db.prepare('SELECT id, event_date, review_reason, published_at FROM leads').get() as { id: string; event_date: string | null; review_reason: string | null; published_at: string | null }
  return { x, row, cur: currentnessHeld(x.db, 'A', row.id), win: leadWindowHeld(x.db, 'A', row.id) }
}
const mustHold = (r: Awaited<ReturnType<typeof held>>, reason: string) => {
  assert.equal(r.row.event_date, null, 'no event date was invented'); assert.equal(r.row.review_reason, reason); assert.equal(r.cur, true, 'draft hold (currentness) stays'); assert.equal(r.win, true, 'window hold stays')
}
const NEW = daysAgo(5)

test('republished OLD opening: the quote says 2019, the page was published this month -> stale, held, not draftable; the publication day is kept only as a label', async () => {
  const q = 'Smile Studio opened its Manhattan dental office in 2019 and has served local families since then'
  const { f } = fx(q, `Published ${NEW}. ${q}.`, NEW)
  const r = await held(f); mustHold(r, 'event_date_stale'); assert.equal(r.row.published_at, NEW)
})
test('historical funding in a new recap: an old year in the quote is stale even when the recap is new', async () => {
  const q = 'In 2019 Smile Studio raised a seed round and opened its first Manhattan office'
  const r = await held(fx(q, `Weekly recap ${NEW}. ${q}.`, NEW).f); mustHold(r, 'event_date_stale')
})
test('multi-article / news-list page: several publication days -> none is attached; the candidate stays undated and held', async () => {
  const q = 'Smile Studio opened a second Manhattan dental office on Court Street'
  const text = `Posted ${daysAgo(2)}. Another story. Posted ${daysAgo(20)}. ${q}. Posted ${daysAgo(40)}. A third story.`
  const r = await held(fx(q, text, null).f); mustHold(r, 'outside_window_undated'); assert.equal(r.row.published_at, null)
})
test('unrelated JSON-LD / markup dates: with no single publication day the page stays undated and held', async () => {
  const q = 'Smile Studio opened a second Manhattan dental office on Court Street'
  const r = await held(fx(q, `${q}. Review posted 2019-02-03 by a patient.`, null).f); mustHold(r, 'outside_window_undated')
})
test('future announced opening: a recent publication day does not make a planned opening a recent event; held', async () => {
  const q = 'Smile Studio will open its second Manhattan dental office in March 2027'
  const r = await held(fx(q, `Published ${NEW}. ${q}.`, NEW).f); mustHold(r, 'outside_window_undated'); assert.equal(r.row.published_at, NEW)
})
test('no event date at all: undated, held, not draftable', async () => {
  const q = 'Smile Studio has opened a new Manhattan dental office and welcomes patients'
  mustHold(await held(fx(q, `${q}.`, null).f), 'outside_window_undated')
})
test('control: a candidate whose event date the FETCHED PAGE states still qualifies and is not held', async () => {
  const q = 'Smile Studio opened a second Manhattan dental office on Court Street this month'
  const r = await held(fx(q, `Published ${NEW}. Opened ${daysAgo(10)}: ${q}.`, NEW, daysAgo(10)).f)
  assert.equal(r.row.review_reason, null); assert.equal(r.row.event_date, daysAgo(10)); assert.equal(r.win, false)
})
test('a date only the search result or the model supplied (the page text never states it) is undated and held, even though it is inside the window', async () => {
  const q = 'Smile Studio opened a second Manhattan dental office on Court Street this month'
  mustHold(await held(fx(q, `${q}.`, null, daysAgo(10)).f), 'outside_window_undated')
})
