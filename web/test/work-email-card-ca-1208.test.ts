// #1208 live check (prod 746ac1b, issue comment 7074013820): the exact made-up page from qc/site1208 (a Toronto company, a bare
// "Email" mailto under <h3>name</h3><p>title</p>) returned no address. The merged card pairing ran only on the US published path;
// a Canadian / UK company's published address is kept on the display path, which judged the address with no title, so a heading
// and a bare mailto never paired there. Same page, same crawl, the product's Claude-only run, no network and no provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawlJob } from '../lib/connectors/sitecrawl.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'

const SITE = 'dazl.ai'
const page = (f: string) => readFileSync(new URL(`./fixtures/site1208/${f}`, import.meta.url), 'utf8')
const HOME = page('index.html'), TEAM = page('team.html')
async function run(team: string) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const ICP = { summary: 'Toronto test companies', who: ['Head of Sales'], where: ['Toronto, ON'], signals: [] }
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'saas', location: 'Toronto, ON' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, run_budget = ? WHERE id = ?").run(JSON.stringify(ICP), JSON.stringify({ provider_policy: 'claude_only_v1' }), job)
  const lead = 'c'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run(lead, job, 'dazl', null, 'Test page for dazl', `https://${SITE}/`, 'dazl finds reviewed, high-intent leads and writes cold outreach from your own Gmail', 90, 80)
  const get = async (url: string) => {
    const p = new URL(url).pathname
    if (p === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const body = p === '/' ? HOME : p === '/team' || p === '/team/' ? team : null
    return body === null ? { status: 404, body: '', finalUrl: url } : { status: 200, body, finalUrl: url }
  }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env: { SITECRAWL_ENABLED: '1' }, now: Date.now(), nativeOnly: true }) // nativeOnly: as the runner crawls a Claude-only run
  const calls: string[] = []
  const r = await findWorkEmail(db, 'T', lead, 'Zorvina Quellbrook|Head of Sales', { env: {}, now: Math.floor(Date.now() / 1000), fetchImpl: (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error('no provider') }) as never })
  db.close()
  return { r: r as { status: string; row?: { address?: string | null; source_url?: string | null } }, calls }
}

test('#1208 live page: her heading, her recorded title and a bare mailto on her own domain give her published address', async () => {
  const { r, calls } = await run(TEAM)
  assert.equal(r.row?.address, 'zorvina@dazl.ai', JSON.stringify(r))
  assert.match(r.row?.source_url ?? '', /^https:\/\/dazl\.ai\/team\/?$/)
  assert.deepEqual(calls, [], 'no provider call')
})

test('#1208 live page, the bar holds: another card\'s address, a changed title line, or a link naming someone is never hers', async () => {
  // her card's mailto is Owen's address: never credited to her (the local part is not hers)
  assert.notEqual((await run(TEAM.replace('mailto:zorvina@dazl.ai', 'mailto:owen2@dazl.ai'))).r.row?.address, 'owen2@dazl.ai')
  // the text between heading and link is not her recorded title
  assert.equal((await run(TEAM.replace('<p class="agent-card__title">Head of Sales</p><a', '<p class="agent-card__title">Head of Sales</p><p>Ask for Owen</p><a'))).r.row?.address ?? null, null)
  // the link names someone
  assert.equal((await run(TEAM.replace('href="mailto:zorvina@dazl.ai">Email<', 'href="mailto:zorvina@dazl.ai">Email Owen<'))).r.row?.address ?? null, null)
  // an address on another domain is never published for her
  assert.equal((await run(TEAM.replace('mailto:zorvina@dazl.ai', 'mailto:zorvina@gmail.com'))).r.row?.address ?? null, null)
})

test('#1208: a Canadian / UK province or nation names its country for the display path; a US state never does', async () => {
  const { publishedDisplayCountry } = await import('../lib/people/published-display.ts')
  assert.equal(publishedDisplayCountry(['Toronto, ON']), 'CA'); assert.equal(publishedDisplayCountry(['Vancouver, British Columbia']), 'CA')
  assert.equal(publishedDisplayCountry(['Edinburgh, Scotland']), 'GB')
  assert.equal(publishedDisplayCountry(['Austin, TX']), null); assert.equal(publishedDisplayCountry(['Toronto, ON', 'Austin, TX']), null)
  assert.equal(publishedDisplayCountry(['Toronto, ON', 'London, UK']), null, 'two countries: no single jurisdiction')
})
