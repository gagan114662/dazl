import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { fetchPageDetailed, htmlToText } from '../lib/scan/fetch-page.ts'
import { checkEmailSource, checkLead } from '../lib/discover/check.ts'
import { runDiscovery } from '../lib/discover/run.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'
import { discoverContact, discoverSources, isDiscoverLead, PAGE_PROVEN_EMAIL_LABEL } from '../lib/discover/card.ts'

import { displayedEmailSource, emailsInText, publishedEmail } from '../lib/outreach/published-email.ts'

const url = 'https://example.com/about'
const email = 'buyer@example.com'
const quote = 'Example is opening a new site'

function discoveryResult(page: string): DiscoverResult {
  return {
    leads: [{ company: 'Example', domain: 'example.com', signal: 'opening a new site',
      signal_date: '2026-11-24', evidence_url: url, evidence_quote: quote,
      person: 'Dana Buyer', title: 'Owner', person_source_url: url, linkedin_url: null,
      email, email_source_url: url, confidence: 'medium', why: '' }],
    seen: [{ url, title: 'Example', page_age: null, text: quote + '. ' + page }],
    usage: { usd: 0.3, requests: 1, searches: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    stop: 'end_turn', model: 'test', note: null,
  }
}

function run(page: string) {
  return runDiscovery({ query: 'opening a new site' }, { maxUsd: 0.3 }, {
    apiKey: 'test', judge: null, enrich: null, discover: async () => discoveryResult(page),
    fetch: async () => { throw new Error('fixture uses only the page already read') },
  })
}

test('a cited page listing only its press inbox does not prove a buyer email', async () => {
  const { leads: [lead] } = await run('Media contact: press@example.com.')
  assert.deepEqual([lead.email, lead.email_source_url], [null, null])
})

test('the exact email on the cited page survives bracket and entity decoding', async () => {
  for (const page of ['Dana Buyer (BUYER [at] Example.com).', 'Dana Buyer (buyer&#64;example&period;com).']) {
    const { leads: [lead] } = await run(page)
    assert.deepEqual([lead.email, lead.email_source_url], [email, url])
  }
})

test('a longer mailbox or hostname does not prove a substring', async () => {
  const { leads: [lead] } = await run('another-buyer@example.com and buyer@example.com.other')
  assert.equal(lead.email, null)
})

test('a legacy discovery citation does not prove the address was read', () => {
  const lead = { source_kind: 'discover', name: 'Dana Buyer', source_url: url,
    enrichments: [{ connector: 'discover', kind: 'email', value: email, source_url: url, label: 'published on a public page' }] }
  assert.equal(discoverContact(lead)?.email, null)
  assert.equal(discoverSources(lead).some(source => source.field === 'email'), false)
})

test('a proof-marked email supplies its own source and a raw guess stays hidden', () => {
  const row = { connector: 'discover', kind: 'email', value: email, source_url: url, label: PAGE_PROVEN_EMAIL_LABEL }
  const proven = { source_kind: 'discover', name: 'Dana Buyer', enrichments: [row] }
  assert.deepEqual(discoverContact(proven)?.email, { address: email, source: url })
  assert.deepEqual(discoverSources(proven), [{ field: 'email', label: 'Email', url }])

  for (const address of [email, 'buyer@other.example']) {
    const guessed = { ...proven, enrichments: [{ ...row, value: address, label: 'guessed' }] }
    assert.equal(discoverContact(guessed)?.email, null)
    assert.deepEqual(discoverSources(guessed), [])
  }
})

test('legacy contact citations use the crawl page or the evidence that contains the address', () => {
  const lead = { contact: email, source_url: url, evidence_excerpt: 'Media contact: press@example.com.' }
  assert.equal(displayedEmailSource(lead, email), null)
  assert.equal(displayedEmailSource({ ...lead, evidence_excerpt: 'Contact: Buyer@example.com.' }, email), url)
  const crawl = { connector: 'sitecrawl', kind: 'email', value: email, source_url: 'https://example.com/team' }
  assert.equal(displayedEmailSource({ ...lead, enrichments: [crawl] }, email), crawl.source_url)
  assert.equal(displayedEmailSource({ ...lead, enrichments: [{ ...crawl, source_url: 'javascript:alert(1)' }] }, email), null)
})

test('search results and other pages do not prove the email; a read of the exact URL can', async () => {
  const lead = { email, email_source_url: url }
  const seen = [
    { url, title: email, page_age: null, text: null },
    { url: 'https://example.com/other', title: null, page_age: null, text: email },
  ]
  assert.deepEqual(await checkEmailSource(lead, seen, async () => null), { email: null, email_source_url: null })
  assert.deepEqual(await checkEmailSource(lead, seen, async source => {
    assert.equal(source, url)
    return { text: email }
  }), lead)
})

test('an incomplete snapshot falls back to the exact cited page and retains its mailto address', async () => {
  const lead = { email, email_source_url: url }
  const snapshot = { url, title: null, page_age: null, text: quote }
  const reads: string[] = []
  const read = async (source: string) => {
    reads.push(source)
    return htmlToText(`<p>${quote}</p><a href="mailto:${email}">Email Dana</a>`, true)
  }
  assert.deepEqual(await checkEmailSource(lead, [snapshot], read), lead)
  assert.deepEqual(reads, [url])
  reads.length = 0
  assert.deepEqual(await checkEmailSource(lead, [{ ...snapshot, text: email }], read), lead)
  assert.deepEqual(reads, [])
})

test('the scan writes no published enrichment for a missing address with guessing off', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const key = randomBytes(32)
    saveKey(db, 'T', 'anthropic', 'sk-ant-test', key)
    const id = createQueryJob(db, 'T', { query: 'Find companies opening a new site', seller: 'Business equipment' })
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const result = discoveryResult('Media contact: press@example.com.')
    assert.equal(await runJob(db, job, { master: key, discover: true, enrichImpl: null,
      discoverImpl: async () => result, fetchImpl: async () => new Response(null, { status: 404 }) }), 'done')
    const row = db.prepare('SELECT id, contact FROM leads WHERE scan_job_id = ?').get(id) as { id: string; contact: string | null }
    assert.equal(row.contact, null)
    assert.deepEqual(db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'email'").all(row.id), [])
  } finally {
    db.close()
  }
})

test('scan stores verified addresses after enrichment and preserves the original source', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const key = randomBytes(32)
    saveKey(db, 'T', 'anthropic', 'sk-ant-test', key)
    const jobId = createQueryJob(db, 'T', { query: 'Find companies opening a new site', seller: 'Business equipment' })
    const job = claimKeyedJob(db, jobId)
    assert.ok(job)
    const result = discoveryResult('Dana Buyer: buyer@example.com.')
    const enrichmentPage = 'https://example.com/team'
    const unsupportedPage = 'https://example.com/contact'
    const enrichedEmail = 'dana.buyer@example.com'
    const unsupportedEmail = 'buyer@other.example'
    const original = result.leads[0]
    for (const company of ['Enriched Example', 'Unsupported Example']) {
      const signalPage = `https://example.com/news/${company.split(' ')[0].toLowerCase()}`
      const evidenceQuote = `${company} is opening a new site`
      result.leads.push({ ...original, company, evidence_url: signalPage, evidence_quote: evidenceQuote,
        person_source_url: `${url}#person`, email: null, email_source_url: null })
      result.seen.push({ url: signalPage, title: company, page_age: null, text: evidenceQuote })
    }
    result.usage.usd = 0.01
    let enrichmentCalls = 0
    assert.equal(await runJob(db, job, {
      master: key, discover: true,
      discoverImpl: async input => input.exclude?.length ? { ...result, leads: [], seen: [] } : result,
      fetchImpl: async () => new Response(null, { status: 404 }),
      enrichImpl: async leads => {
        enrichmentCalls++
        return {
          leads: leads.map(lead => ({ ...lead,
            email: lead.company === 'Enriched Example' ? enrichedEmail : unsupportedEmail,
            email_source_url: lead.company === 'Enriched Example' ? enrichmentPage : unsupportedPage,
          })),
          usage: { ...result.usage, usd: 0.01 },
          seen: [
            { url: enrichmentPage, title: 'Team', page_age: null, text: `Dana Buyer: ${enrichedEmail}` },
            { url: unsupportedPage, title: 'Contact', page_age: null, text: 'Media: press@example.com' },
          ],
          enriched: leads.length,
        }
      },
    }), 'done')
    assert.equal(enrichmentCalls, 1)
    const rows = db.prepare(`SELECT l.company, e.kind, e.connector, e.value, e.label, e.source_url
      FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id
      WHERE l.scan_job_id = ? AND e.kind = 'email' ORDER BY l.company`).all(jobId) as
      { company: string; kind: string; connector: string; value: string; label: string; source_url: string }[]
    assert.deepEqual(rows.map(row => [row.company, row.value, row.label, row.source_url]), [
      ['Enriched Example', enrichedEmail, PAGE_PROVEN_EMAIL_LABEL, enrichmentPage],
      ['Example', email, PAGE_PROVEN_EMAIL_LABEL, url],
    ])
    for (const row of rows) {
      assert.deepEqual(discoverContact({ source_kind: 'discover', name: 'Dana Buyer', enrichments: [row] })?.email,
        { address: row.value, source: row.source_url })
    }
    const stored = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ?').get(jobId) as { report: string }
    assert.equal(JSON.parse(stored.report).discover.emails_dropped, 1)
    assert.equal(JSON.parse(stored.report).discover.email_dropped, 'not_on_source')
  } finally {
    db.close()
  }
})


test('the own-fetch proof retains published mailto and Cloudflare addresses', async () => {
  const encoded = '5a' + [...email].map(char => (char.charCodeAt(0) ^ 0x5a).toString(16).padStart(2, '0')).join('')
  for (const markup of [
    `<a href="mailto:${email}">Email Dana</a>`,
    `<span class="__cf_email__" data-cfemail="${encoded}">[email protected]</span>`,
  ]) {
    const result = await checkLead(discoveryResult('').leads[0], [], async () => new Response(`<p>${quote}</p>${markup}`))
    assert.equal(result.email, email, markup)
    assert.equal(result.email_source_url, url)
  }
  const hidden = await checkLead(discoveryResult('').leads[0], [], async () =>
    new Response(`<p data-email="${email}">${quote}</p><script>const internal = "${email}";</script>`))
  assert.equal(hidden.email, null)
})

type CitationResponse = { status: number; body?: string; location?: string }

function stubCitationTransport(t: TestContext, pages: Record<string, CitationResponse>): string[] {
  const hits: string[] = []
  t.mock.method(https, 'request', (target: URL, _options: unknown, receive: (response: PassThrough) => void) => {
    hits.push(target.href)
    const fixture = pages[target.href]
    if (!fixture) throw new Error(`Unexpected citation request: ${target.href}`)
    return Object.assign(new EventEmitter(), {
      end() {
        const response = Object.assign(new PassThrough(), {
          statusCode: fixture.status,
          headers: { 'content-type': 'text/html', location: fixture.location },
        })
        receive(response)
        response.end(fixture.body)
      },
      destroy() {},
    })
  })
  return hits
}

test('a 404 proof response clears the cited email even if the error body contains it', async t => {
  const hits = stubCitationTransport(t, {})
  const result = await checkLead(discoveryResult('').leads[0], [], async () => new Response(email, { status: 404 }))
  assert.equal(result.proof, 'gone')
  assert.deepEqual([result.email, result.email_source_url], [null, null])
  assert.deepEqual(hits, [])
})

test('the unread proof branch checks the real citation and clears its unreadable address', async t => {
  const citation = 'https://example.com/contact'
  const hits = stubCitationTransport(t, { [citation]: { status: 404, body: email } })
  const lead = { ...discoveryResult('').leads[0], email_source_url: citation }
  const result = await checkLead(lead, [], async () => new Response('Unavailable', { status: 503 }))
  assert.equal(result.proof, 'unseen')
  assert.deepEqual([result.email, result.email_source_url], [null, null])
  assert.deepEqual(hits, [citation])
})

test('the real citation reader refuses to follow a cross-host redirect', async t => {
  const foreign = 'https://other.example/contact'
  const hits = stubCitationTransport(t, {
    [url]: { status: 302, location: foreign },
    [foreign]: { status: 200, body: `<p>${quote}. ${email}</p>` },
  })
  const result = await checkEmailSource({ email, email_source_url: url }, [])
  assert.deepEqual(result, { email: null, email_source_url: null })
  assert.deepEqual(hits, [url])
})

test('the real citation reader extracts mailto evidence only with the opt-in', async t => {
  const body = `<html><body><p>${quote}. Contact our office for details.</p><a href="mailto:${email}">Email the office</a></body></html>`
  const hits = stubCitationTransport(t, { [url]: { status: 200, body } })
  const ordinary = await fetchPageDetailed(url, async () => null)
  assert.ok('text' in ordinary)
  assert.ok(!ordinary.text.includes(email))
  const lead = { email, email_source_url: url }
  assert.deepEqual(await checkEmailSource(lead, []), lead)
  assert.deepEqual(hits, [url, url])
})

test('the lead card disables Approve when the recipient source is hidden', () => {
  const filename = new URL('../app/app/leads/leads-client.tsx', import.meta.url)
  const source = ts.createSourceFile('leads-client.tsx', readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function find(node: ts.Node): ts.JsxElement | undefined {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'button' &&
        node.children.some(child => ts.isJsxText(child) && child.getText(source).trim() === 'Approve')) return node
    return node.forEachChild(find)
  }
  const button = find(source)
  assert.ok(button)
  let parent: ts.Node = button
  while (!ts.isBlock(parent) || !parent.statements.some(statement => statement.getText(source).startsWith('const lp ='))) parent = parent.parent
  const declarations = parent.statements.filter(statement => ts.isVariableStatement(statement))
    .slice(2).map(statement => statement.getText(source))
  const compiled = ts.transpileModule(`${declarations.join('\n')}
exports.button = (${button.getText(source)})`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const render = (evidence_excerpt: string) => {
    const exports = { button: null }
    vm.runInNewContext(compiled, { exports, require: createRequire(import.meta.url),
      l: { id: 'proof', contact: email, source_url: url, evidence_excerpt }, lp: null,
      c: { contact: email, contactNoPerson: email, approve: { ok: true } },
      approving: {}, approved: {}, Icon: () => null, displayedEmailSource, discoverContact, emailsInText, isDiscoverLead, publishedEmail,
    })
    return renderToStaticMarkup(exports.button)
  }
  assert.match(render('The page lists press@example.com.'), /disabled=""/)
  assert.doesNotMatch(render(`Contact Dana at ${email}.`), /disabled=""/)
})
