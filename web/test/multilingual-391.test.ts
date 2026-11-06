// #391 multilingual retrieval and matching: synthetic per-language fixtures (Arabic, Hindi, Japanese, plus code-mixed and
// transliterated names). Isolated in-memory DBs, stub providers and stub fetch only: no network, no paid call, no model.
// What this proves: the deterministic text paths (keywords, adapter matching, identity tokens, lookalike similarity, dates,
// windows, hiring-role queries, market planning, translated-quote linking) handle these scripts. It is NOT live yield.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { aliasKey, companyNameTokens, foldText, scriptOf, transliteratedAlias, words } from '../lib/text/multilingual.ts'
import { keywordsFor, mentionsKeyword, buildSourcePrompt } from '../lib/sources/index.ts'
import { rssAdapter } from '../lib/sources/rss.ts'
import { pickQuote as pickJinaQuote } from '../lib/sources/jina.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { classifyEntityMatch, classifyBoardMatch, nameTokens as entityTokens } from '../lib/signals/entity-match.ts'
import { nameTokens as signalTokens } from '../lib/signals/index.ts'
import { companyKey as eventCompanyKey } from '../lib/events/store.ts'
import { companyKey, norm, verifyEvidence } from '../lib/scan/evidence.ts'
import { tokens, sharedTokens, sameLabel } from '../lib/scan/lookalike.ts'
import { datesStatedIn, datePositions } from '../lib/scan/date-in-text.ts'
import { parseWindowDays } from '../lib/scan/window.ts'
import { directQueries, hasHiringSignal } from '../lib/search/direct-queries.ts'
import { normalizeIcp, normalizeMarkets, icpPrompt } from '../lib/scan/icp.ts'
import { planMarketQueries, marketPlan, marketYield, searchMarkets } from '../lib/search/markets.ts'
import { queryPrompt } from '../lib/search/tinyfish.ts'
import { buildRunReport, runReportFor } from '../lib/scan/run-report.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { claimKeyedJob, parseLeads, runJob } from '../lib/scan/runner.ts'

// ---- fixtures, one block per language -------------------------------------------------------------------------------
const AR = { request: 'شركات تقنية في دبي توظف مدير مبيعات', place: 'دبي', company: 'أرامكو', latin: 'Aramco', role: 'مدير مبيعات' }
const HI = { request: 'पुणे में सेल्स मैनेजर की भर्ती करने वाली कंपनियां', place: 'पुणे', company: 'टाटा मोटर्स', latin: 'Tata Motors', mixed: 'Tata मोटर्स', role: 'सेल्स मैनेजर' }
const JA = { request: '東京でセールスマネージャーを採用しているSaaS企業', place: '東京', company: 'ソフトバンク', latin: 'SoftBank', role: 'セールスマネージャー' }

test('script detection and folding keep the original script (no Latin-only erasure)', () => {
  assert.equal(scriptOf(AR.company), 'arabic'); assert.equal(scriptOf(HI.company), 'devanagari'); assert.equal(scriptOf(JA.company), 'japanese')
  assert.equal(foldText('الرَّاجِحِي'), 'الراجحي', 'Arabic harakat are folded')
  assert.equal(foldText('أرامكو'), 'ارامكو', 'alef variants are folded')
  assert.equal(foldText('٢٠٢٦ और २०२६'), '2026 और 2026', 'Arabic-Indic and Devanagari digits are digits')
  assert.equal(foldText('ＳｏｆｔＢａｎｋ'), 'softbank', 'full-width Latin is NFKC-folded')
  assert.deepEqual(words(JA.request), ['東京', 'セールスマネージャー', '採用', 'saas', '企業'], 'Japanese is cut at script changes; hiragana particles dropped')
})

test('Arabic / Hindi / Japanese requests produce keywords in their own script (before: none)', () => {
  assert.deepEqual(keywordsFor(AR.request), ['تقنية', 'دبي', 'توظف', 'مدير', 'مبيعات'], 'Arabic keywords keep the request spelling (ة not folded for search)')
  const hi = keywordsFor(HI.request)
  assert.deepEqual(hi.slice(0, 4), ['पुणे', 'सेल्स', 'मैनेजर', 'भर्ती'])
  assert.ok(hi.includes('sels'), 'a romanized alias of a Devanagari loan word follows the originals')
  const ja = keywordsFor(JA.request)
  assert.deepEqual(ja.slice(0, 4), ['東京', 'セールスマネージャー', '採用', 'saas'])
  // English is unchanged
  assert.deepEqual(keywordsFor('Looking for seed-stage fintech founders who hired sales'), ['seed-stage', 'fintech', 'founders', 'hired', 'sales'])
  // code-mixed: both scripts are kept, the Devanagari word also gets its alias
  const mixed = keywordsFor(`${HI.mixed} hiring in Pune`)
  assert.ok(mixed.includes('tata') && mixed.includes('मोटर्स') && mixed.includes('motars'), String(mixed))
})

test('adapters match source text across scripts: same script folded, transliteration by consonant skeleton only across scripts', async () => {
  assert.equal(mentionsKeyword('شركة أرامكو تعلن عن وظائف', ['ارامكو']), true, 'alef variant in the text matches')
  assert.equal(mentionsKeyword('Tata Motors opens a new plant in Pune', keywordsFor(HI.company)), true, 'Devanagari keyword finds the English spelling')
  assert.equal(mentionsKeyword(`${HI.company} ने पुणे में भर्ती शुरू की`, ['motors']), true, 'English keyword finds the Devanagari spelling')
  assert.equal(mentionsKeyword('ソフトバンクが営業職を募集', keywordsFor('SoftBank')), true, 'katakana brand found from the Latin name')
  assert.equal(mentionsKeyword('Slow sales this quarter', ['sells']), false, 'same-script words never match through the lossy skeleton')
  // the RSS adapter end to end with a stub feed (no network)
  const feed = `<?xml version="1.0"?><rss><channel>
<item><title>टाटा मोटर्स ने पुणे में सेल्स टीम के लिए भर्ती शुरू की</title><link>https://news.example/hi/1</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>أرامكو تعلن عن وظائف مدير مبيعات في دبي</title><link>https://news.example/ar/1</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>ソフトバンクが東京で営業マネージャーを募集</title><link>https://news.example/ja/1</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Unrelated gardening news for the weekend</title><link>https://news.example/en/1</link></item></channel></rss>`
  const http: SafeGet = async () => ({ status: 200, body: feed })
  const got = (q: string) => rssAdapter.collect({ query: q, keywords: keywordsFor(q), feeds: ['https://news.example/feed'], http }).then(xs => xs.map(x => x.url))
  assert.deepEqual(await got(HI.request), ['https://news.example/hi/1'])
  assert.deepEqual(await got(AR.request), ['https://news.example/ar/1'])
  assert.deepEqual(await got('東京 営業マネージャー 募集'), ['https://news.example/ja/1'])
  assert.deepEqual(await got('Tata Motors Pune'), ['https://news.example/hi/1'], 'transliterated (English) request finds the Hindi item')
})

test('web adapter quotes a Japanese / Arabic page in its own script (before: latin-only quote, empty)', () => {
  const ja = 'ソフトバンク株式会社は東京本社で法人営業マネージャーを3名募集しています。応募は採用ページから受け付けます。'
  assert.ok(pickJinaQuote(ja, ['営業マネージャー']).includes('法人営業マネージャーを3名募集'), 'quote keeps the Japanese passage')
  const ar = 'أعلنت شركة أرامكو اليوم عن فتح باب التوظيف لمنصب مدير مبيعات إقليمي في دبي. التقديم متاح عبر الموقع.'
  assert.ok(pickJinaQuote(ar, ['مدير']).includes('مدير مبيعات إقليمي في دبي'))
})

test('identity keys: Arabic, Hindi, Japanese names tokenize meaningfully; legal forms removed', () => {
  assert.deepEqual(entityTokens('株式会社サイボウズ'), ['サイボウズ']); assert.deepEqual(entityTokens('サイボウズ株式会社'), ['サイボウズ'])
  assert.deepEqual(entityTokens('شركة الرَّاجِحِي المحدودة'), ['الراجحي'])
  assert.deepEqual(entityTokens('टाटा मोटर्स प्राइवेट लिमिटेड'), ['टाटा', 'मोटर्स'])
  assert.deepEqual(signalTokens('टाटा मोटर्स लिमिटेड'), ['टाटा', 'मोटर्स'], 'funding-round matching gets tokens (before: [])')
  assert.deepEqual(signalTokens('Acme Robotics Inc'), ['acme', 'robotics'], 'English unchanged')
  assert.equal(companyKey('株式会社サイボウズ'), norm('サイボウズ')); assert.equal(companyKey('サイボウズ株式会社'), norm('サイボウズ'), 'same key either way round (in norm() form, as the verifier compares)')
  assert.equal(companyKey('شركة أرامكو'), norm('أرامكو'), 'evidence key keeps norm() form (no Arabic folding) so the verifier compares like with like')
  assert.equal(companyKey('टाटा मोटर्स प्राइवेट लिमिटेड'), norm('टाटा मोटर्स'))
  assert.deepEqual(companyNameTokens('Al Noor Trading LLC', new Set(['llc'])), ['al', 'noor', 'trading'])
})

test('same-name entities stay separate: alias never confirms, funds never confirm, identity is domain-bound', () => {
  assert.equal(classifyEntityMatch('株式会社サイボウズ', 'サイボウズ株式会社'), 'heuristic', 'same name, same script')
  assert.equal(classifyEntityMatch('الراجحي', 'شركة الرَّاجِحِي المحدودة'), 'heuristic', 'diacritics and legal form aside')
  assert.equal(classifyEntityMatch('Cybozu', 'サイボウズ'), 'unconfirmed', 'a transliteration is never corroboration')
  assert.equal(classifyEntityMatch(HI.latin, HI.company), 'unconfirmed')
  assert.equal(classifyEntityMatch('ソフトバンク', 'ソフトバンク・ビジョン・ファンド'), 'unconfirmed', 'Japanese fund word')
  assert.equal(classifyEntityMatch('الراجحي', 'صندوق الراجحي'), 'unconfirmed', 'Arabic fund word')
  assert.equal(classifyEntityMatch('टाटा मोटर्स', 'टाटा स्टील'), 'unconfirmed', 'shared family name is a different company')
  // Two companies with the same name in two markets: event identity is the domain, never the name.
  assert.notEqual(eventCompanyKey('alnoor.ae', 'lead-1'), eventCompanyKey('alnoor.sa', 'lead-2'))
  assert.equal(classifyBoardMatch('alnoor.ae', 'https://boards.greenhouse.io/alnoorksa'), 'unconfirmed')
  // The lossy alias exists for retrieval only
  assert.equal(transliteratedAlias(HI.latin, HI.company), true); assert.equal(transliteratedAlias(HI.latin, HI.mixed), true)
  assert.equal(transliteratedAlias(JA.latin, JA.company), true); assert.equal(transliteratedAlias(AR.latin, AR.company), true)
  assert.equal(transliteratedAlias(HI.latin, 'Toto Motors'), false, 'same-script names are never alias-matched')
  assert.equal(aliasKey('東京海上'), null, 'Han has no reading without a dictionary: no alias is invented')
})

test('lookalike similarity counts code-mixed / transliterated signal words once; English unchanged', () => {
  const en = tokens('Tata Motors hiring sales engineers in Pune')
  const hi = tokens(`${HI.company} पुणे में सेल्स इंजीनियर भर्ती`)
  assert.ok(hi.size >= 4, 'a Hindi signal has tokens (before: none)')
  assert.equal(sharedTokens(en, hi), 2, 'motors~मोटर्स and sales~सेल्स')
  const mixed = tokens(`${HI.mixed} sales team hiring`)
  assert.ok(sharedTokens(en, mixed) >= 2)
  const a = tokens('company hiring sales operations manager for crm administration rollout 1'), b = tokens('company hiring sales operations manager for crm administration rollout 2')
  assert.equal(sharedTokens(a, b), [...a].filter(t => b.has(t)).length, 'two English signals score exactly as plain intersection')
  assert.ok(tokens('ソフトバンクが東京で営業マネージャーを募集').has('ソフトバンク'))
  assert.ok(tokens('أرامكو توظف مدير مبيعات في دبي').has('ارامكو'))
  assert.equal(sameLabel('دبي', 'دبي'), true); assert.equal(sameLabel('Dubai', 'دبي'), false, 'places never match through an alias')
})

test('dates and windows in Japanese, Arabic and Hindi', () => {
  assert.deepEqual([...datesStatedIn('2026年10月8日に発表しました')], ['2026-10-08'])
  assert.deepEqual([...datesStatedIn('أعلنت الشركة في ٨ أكتوبر ٢٠٢٦ عن التوظيف')], ['2026-10-08'])
  assert.deepEqual([...datesStatedIn('कंपनी ने 8 अक्टूबर 2026 को घोषणा की')], ['2026-10-08'])
  assert.deepEqual([...datesStatedIn('2026年2月30日')], [], 'an impossible day is still refused')
  const text = 'ニュース 2026年10月8日 ソフトバンクが募集'
  const p = datePositions(text)[0]
  assert.equal(text.slice(p.index, p.end), '2026年10月8日', 'positions point into the original text')
  assert.equal(parseWindowDays('पुणे में भर्ती पिछले 30 दिनों में'), 30)
  assert.equal(parseWindowDays('شركات توظف خلال آخر ٣ أشهر'), 90)
  assert.equal(parseWindowDays('過去30日以内に採用'), 30)
  assert.equal(parseWindowDays('直近3か月の求人'), 90)
  assert.equal(parseWindowDays('past 90 days'), 90, 'English unchanged')
})

test('hiring-role queries for Arabic, Hindi and Japanese requests (role and place in the original script)', () => {
  for (const f of [AR, HI, JA]) {
    assert.equal(hasHiringSignal(f.request, []), true, f.request)
    const q = directQueries(f.request, [], [f.place])
    assert.equal(q.length, 2, f.request)
    for (const x of q) { assert.ok(x.includes(`"${f.role}"`), x); assert.ok(x.endsWith(f.place), x) }
  }
  assert.deepEqual(directQueries(`${HI.request} पिछले 30 दिनों में`, [], [HI.place]).map(x => x.match(/"[^"]+"/)?.[0]), ['"सेल्स मैनेजर"', '"सेल्स मैनेजर"'], 'the window is not a role')
})

// ---- markets -----------------------------------------------------------------------------------------------------
const MARKETS = [{ where: '東京', country: 'JP', language: 'ja' }, { where: 'Dubai', country: 'AE', language: 'ar' }, { where: 'Pune', country: 'IN', language: 'hi' }]

test('a multi-country multilingual profile carries bounded markets; a single market changes nothing', () => {
  assert.deepEqual(normalizeMarkets([...MARKETS, { where: 'Lisbon', country: 'PT', language: 'pt' }]), MARKETS, 'at most 3')
  assert.deepEqual(normalizeMarkets([{ where: 'Dubai', country: 'UAE?', language: 'arabic' }, { where: 'x', country: 'JP' }]), undefined, 'invalid entries dropped; under 2 = no markets')
  assert.deepEqual(normalizeMarkets([{ where: 'London', country: 'UK' }, { where: 'london', country: 'GB' }, { where: 'Pune', country: 'IN', language: 'HI' }]), [{ where: 'London', country: 'GB' }, { where: 'Pune', country: 'IN', language: 'hi' }])
  const icp = normalizeIcp({ summary: 'SaaS in Tokyo, Dubai, Pune hiring sales', where: ['東京', 'Dubai', 'Pune'], markets: MARKETS })!
  assert.deepEqual(icp.markets, MARKETS)
  assert.equal(normalizeIcp({ summary: 'x', country: 'PT', language: 'pt' })!.markets, undefined)
  assert.match(icpPrompt('SaaS in Tokyo and Dubai'), /"markets": when the request names places in MORE than one country/)
  assert.deepEqual(searchMarkets({ markets: [MARKETS[0]] }), [], 'one market: the old single country/language search')
  const prompt = queryPrompt('SaaS sales hiring in Tokyo, Dubai and Pune', icp, 6)
  assert.match(prompt, /covers 3 markets: "東京" \(Japanese\), "Dubai" \(Arabic\), "Pune" \(Hindi\)/)
})

test('market planning visits every intended market within the same query budget', () => {
  const t = planMarketQueries(['SaaS 営業 採用 東京', 'SaaS sales hiring', 'B2B software sales manager', 'sales team expansion'], MARKETS)
  assert.equal(t.length, 4, 'never more queries')
  assert.deepEqual(t.map(x => x.market?.where), ['東京', 'Dubai', 'Pune', '東京'])
  assert.deepEqual(t.map(x => x.query), ['SaaS 営業 採用 東京', 'SaaS sales hiring Dubai', 'B2B software sales manager Pune', 'sales team expansion 東京'])
  // the model wrote every query for one market: an uncovered market borrows one, with the place swapped
  const skew = planMarketQueries(['営業 東京 一', '営業 東京 二', '営業 東京 三'], MARKETS)
  assert.deepEqual(skew.map(x => x.market?.where).sort(), ['Dubai', 'Pune', '東京'])
  assert.ok(skew.some(x => x.query === '営業 Pune 二') && skew.some(x => x.query === '営業 Dubai 三'), JSON.stringify(skew))
  // budget of one: cannot cover three markets, and says so through the plan (queries: 0)
  const one = planMarketQueries(['SaaS sales hiring'], MARKETS)
  assert.deepEqual(marketPlan(MARKETS, one).map(p => p.queries), [1, 0, 0])
  assert.deepEqual(planMarketQueries(['a b c d'], []), [{ query: 'a b c d', market: null }])
})

test('per-market usable yield is measured from the candidates each market produced', () => {
  const tasks = planMarketQueries(['q 東京', 'q Dubai', 'q Pune'], MARKETS)
  const plan = marketPlan(MARKETS, tasks)
  const y = marketYield(plan, [{ url: 'https://a.jp/1', market: plan[0].market }, { url: 'https://b.ae/1', market: plan[1].market }, { url: 'https://b.ae/2/', market: plan[1].market }],
    [{ url: 'https://a.jp/1', fate: 'verified' }, { url: 'https://b.ae/1', fate: 'verified' }, { url: 'https://b.ae/2', fate: 'review:quote_unconfirmed' }])
  assert.deepEqual(y.map(m => [m.market, m.queries, m.result_urls, m.candidates, m.verified, m.needs_review, m.usable_yield]), [
    ['東京 (JP/ja)', 1, 1, 1, 1, 0, 1], ['Dubai (AE/ar)', 1, 2, 2, 1, 1, 0.5], ['Pune (IN/hi)', 1, 0, 0, 0, 0, null],
  ])
})

test('a translated quote is linked to its original passage and URL, and never stands in for it', () => {
  const page = { text: 'ソフトバンク株式会社は2026年10月8日、東京本社で法人営業マネージャーを3名募集すると発表した。', title: 'ソフトバンク 採用', retrievedAt: 1 }
  const original = 'ソフトバンク株式会社は2026年10月8日、東京本社で法人営業マネージャーを3名募集すると発表した'
  const translation = 'SoftBank announced on 8 October 2026 that it is hiring three corporate sales managers at its Tokyo HQ'
  const [lead] = parseLeads(JSON.stringify([{ name: '', company: 'ソフトバンク', signal: 'Hiring 3 sales managers', source_url: 'https://sb.example/jobs', excerpt: original, excerpt_en: translation, event_date: null, score: 80 }]), ['https://sb.example/jobs'])!
  assert.equal(lead.excerpt, original); assert.equal(lead.excerpt_translation, translation)
  assert.equal(verifyEvidence({ ...lead }, page).ok, true, 'the original passage verifies on the page')
  assert.equal(verifyEvidence({ ...lead, excerpt: translation }, page).ok, false, 'a translation used as the quote is not on the page')
  const [same] = parseLeads(JSON.stringify([{ company: 'Acme', signal: 's', source_url: 'https://a.example/x', excerpt: 'Acme is hiring sales reps now in Ohio', excerpt_en: 'Acme is hiring sales reps now in Ohio' }]), ['https://a.example/x'])!
  assert.equal('excerpt_translation' in same, false, 'an identical "translation" is not kept')
  const r = buildRunReport({ audit: [{ key: 'k', company: 'ソフトバンク', url: 'https://sb.example/jobs', outcome: 'passed', reason: null, excerpt: original, excerpt_translation: translation }] }, [{ key: 'k' }], [], 1)
  assert.deepEqual((r.candidates[0] as { quote?: unknown }).quote, { original, translation, source_url: 'https://sb.example/jobs', translation_is_evidence: false })
  assert.match(buildSourcePrompt('q', null, []), /never translate it/)
})

// ---- end to end: one scan, three markets, three scripts ------------------------------------------------------------
const master = randomBytes(32)
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const PAGES: Record<string, { country: string; title: string; text: string; lead: Record<string, unknown> }> = {}
{
  const d = day(10), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate()
  const AR_MON = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'][m - 1]
  const HI_MON = ['जनवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'][m - 1]
  const ja = `ソフトバンクは${y}年${m}月${dd}日、東京本社で法人営業マネージャーを3名募集すると発表しました`
  const ar = `أعلنت أرامكو في ${dd} ${AR_MON} ${y} عن توظيف مدير مبيعات إقليمي جديد في مكتب دبي`
  const hi = `Tata मोटर्स ने ${dd} ${HI_MON} ${y} को पुणे संयंत्र के लिए सेल्स मैनेजर की भर्ती शुरू की`
  PAGES['https://jp.example/softbank-jobs'] = { country: 'JP', title: 'ソフトバンク 採用情報', text: `${ja}。応募は採用ページから受け付けます。`, lead: { company: 'ソフトバンク', excerpt: ja, excerpt_en: 'SoftBank is hiring three corporate sales managers in Tokyo' } }
  PAGES['https://ae.example/aramco-jobs'] = { country: 'AE', title: 'أرامكو وظائف', text: `${ar}. التقديم متاح عبر الموقع الرسمي للشركة.`, lead: { company: 'أرامكو', excerpt: ar, excerpt_en: 'Aramco is hiring a regional sales manager in Dubai' } }
  PAGES['https://in.example/tata-jobs'] = { country: 'IN', title: 'Tata मोटर्स भर्ती', text: `${hi}। आवेदन वेबसाइट पर करें।`, lead: { company: 'Tata मोटर्स', excerpt: hi } }
  for (const [url, p] of Object.entries(PAGES)) Object.assign(p.lead, { name: '', contact: null, signal: 'Hiring a sales manager', source_url: url, event_date: iso(d), score: 80 })
}

test('one scan over Tokyo, Dubai and Pune searches each market with its own country/language and reports per-market yield', async () => {
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-test-0000000000000000000000AAAA', master)
  const icp = { summary: 'SaaS companies hiring sales managers in Tokyo, Dubai and Pune', who: ['Head of Sales'], industries: ['SaaS'], sizes: [], where: ['東京', 'Dubai', 'Pune'], signals: ['hiring a sales manager'], exclude: [], markets: MARKETS }
  const jobId = createQueryJob(db, 'A', { query: 'SaaS companies hiring sales managers in 東京, Dubai and Pune', icp: JSON.stringify(icp) })
  const job = claimKeyedJob(db)!
  const searches: { q: string; location: string | null; language: string | null }[] = []
  const realFetch = globalThis.fetch
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      const sp = new URL(u).searchParams, q = sp.get('query') ?? ''
      if (q.startsWith('site:linkedin.com/in ')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      searches.push({ q, location: sp.get('location'), language: sp.get('language') })
      const results = Object.entries(PAGES).filter(([, p]) => p.country === sp.get('location')).map(([url, p]) => ({ url, title: p.title, snippet: p.text.slice(0, 120), date: p.lead.event_date }))
      return new Response(JSON.stringify({ results }), { status: 200 })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
      return new Response(JSON.stringify({ results: urls.filter(x => PAGES[x]).map(x => ({ url: x, title: PAGES[x].title, text: PAGES[x].text })) }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: '', citedUrls: [] }),
      complete: async (_k: string, _p: string, _f?: typeof fetch, maxTokens?: number) => maxTokens === 300
        ? JSON.stringify(['SaaS 営業マネージャー 採用 東京', 'SaaS sales manager hiring', 'شركات تقنية توظف مدير مبيعات', 'सेल्स मैनेजर भर्ती SaaS'])
        : JSON.stringify(Object.values(PAGES).map(p => p.lead)),
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async (url: string) => PAGES[url] ? { text: PAGES[url].text, title: PAGES[url].title, retrievedAt: Math.floor(Date.now() / 1000) } : null
  globalThis.fetch = fetchImpl
  try {
    const r = await runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, judge: null })
    assert.equal(r, 'done')
  } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
  // every intended market was searched, each with its own country and language
  for (const m of MARKETS) assert.ok(searches.some(s => s.location === m.country && s.language === m.language), `${m.where} never searched: ${JSON.stringify(searches)}`)
  for (const s of searches) {
    const m = MARKETS.find(x => x.country === s.location)!
    assert.ok(m, `a search without a market: ${s.q}`)
    assert.ok(s.q.includes(m.where) || (m.where === '東京' && /東京/.test(s.q)), `query is bound to ${m.where} but does not name it: ${s.q}`)
  }
  const report = (runReportFor(db, 'A', String(jobId)) ?? [])[0] as { markets?: { market: string; queries: number; result_urls: number; candidates: number; verified: number; usable_yield: number | null }[] } | undefined
  assert.ok(report?.markets, 'the run report carries the per-market measurement')
  assert.deepEqual(report!.markets!.map(m => m.market), ['東京 (JP/ja)', 'Dubai (AE/ar)', 'Pune (IN/hi)'])
  for (const m of report!.markets!) { assert.ok(m.queries >= 1, m.market); assert.equal(m.result_urls, 1, m.market); assert.equal(m.candidates, 1, m.market) }
  const leads = db.prepare('SELECT company, evidence_excerpt, review_reason FROM leads').all() as { company: string; evidence_excerpt: string; review_reason: string | null }[]
  assert.equal(leads.length, 3, JSON.stringify(leads))
  for (const l of leads) assert.ok(Object.values(PAGES).some(p => p.lead.excerpt === l.evidence_excerpt), 'the stored quote is the ORIGINAL-language passage')
  // record what the fixture measured (synthetic, not live yield)
  console.log('per-market fixture yield:', JSON.stringify(report!.markets!.map(m => ({ market: m.market, queries: m.queries, candidates: m.candidates, verified: m.verified, usable_yield: m.usable_yield }))))
})
