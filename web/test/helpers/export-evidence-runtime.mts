import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob, listLeads } from '../../lib/scan/store.ts'
import { storeEvidenceCopy, purgeTenantEvidence } from '../../lib/scan/evidence-copies.ts'
import { GET as exportGET } from '../../app/api/leads/export/route.ts'
import { GET as evidenceGET } from '../../app/api/leads/evidence/route.ts'

// Real export and evidence routes, in-memory DB, no network. Four rows for tenant A: a verified copy, an unreadable review row,
// a user-confirmed blocked row and a row with no origin recorded. None may claim dazl read the page.
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const hex = () => randomBytes(12).toString('hex')
const get = (p: string) => new NextRequest(`http://localhost${p}`, { method: 'GET' })
const TEXT = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist. '.repeat(10)
function parseCsv(csv: string): Record<string, string>[] {
  const rows: string[][] = []; let cur: string[] = [], f = '', q = false
  for (let i = 0; i < csv.length; i++) { const c = csv[i]
    if (q) { if (c === '"' && csv[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c }
    else if (c === '"') q = true; else if (c === ',') { cur.push(f); f = '' } else if (c === '\n') { cur.push(f); rows.push(cur); cur = []; f = '' } else if (c !== '\r') f += c }
  if (f || cur.length) { cur.push(f); rows.push(cur) }
  const [h, ...rest] = rows; return rest.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])))
}
test('export route: copied evidence is labelled as a copy; unreadable and user-confirmed blocked rows say dazl could not read the page; nothing claims a direct read; evidence route is tenant-scoped', async () => {
  const db = new Database(':memory:'); migrateScan(db); setScanDb(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status='running', attempts=1 WHERE id=?").run(job)
  const page = { url: 'https://jobs.example/hf', title: 'Harbor Freight Supply \u2014 Careers', text: TEXT, sha256: createHash('sha256').update(TEXT).digest('hex'), heldAt: 1_700_000_000 }
  const copyId = storeEvidenceCopy(db, 'A', job, 1, page)
  const ins = db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,confidence,review_reason,human_confirmed_at,human_confirmed_from,evidence_origin,own_fetch_failure,evidence_copy_sha256,evidence_copy_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const ids = { copy: hex(), review: hex(), confirmed: hex(), plain: hex() }
  ins.run(ids.copy, job, 'CopyCo', 's', 'https://jobs.example/hf', 70, null, null, null, 'tinyfish_copy', 'blocked_by_site', page.sha256, copyId)
  ins.run(ids.review, job, 'ReviewCo', 's', 'https://blocked.example/a', null, 'blocked_by_site', null, null, null, null, null, null)
  ins.run(ids.confirmed, job, 'ConfirmedCo', 's', 'https://blocked.example/b', null, null, 1_700_000_000, 'blocked_by_site', null, null, null, null)
  ins.run(ids.plain, job, 'PlainCo', 's', 'https://open.example/c', 70, null, null, null, null, null, null, null)
  setUser({ id: 'A', business_name: 'Acme' })
  const res = await exportGET(get(`/api/leads/export?job_id=${job}`)); assert.equal(res.status, 200)
  const rows = parseCsv(await res.text()); const by = (c: string) => rows.find(r => r['Company'] === c)!
  const col = Object.keys(rows[0]).find(k => k.startsWith('Evidence Origin'))!
  assert.doesNotMatch(col, /dazl read the page/i)
  assert.match(by('CopyCo')[col], /copy of the page fetched by TinyFish.*did not read the page directly/)
  assert.match(by('ReviewCo')[col], /Not verified: dazl could not read this page \(blocked_by_site\)/)
  assert.match(by('ConfirmedCo')[col], /Confirmed by you, not verified by dazl: dazl could not read this page \(blocked_by_site\)/)
  assert.equal(by('PlainCo')[col], '', 'nothing recorded -> blank, and the header does not say blank means a direct read')
  for (const r of rows) assert.doesNotMatch(r[col], /read (?:on )?the page (?:itself|directly) by dazl|dazl read the page/i)
  // evidence route: owner recovers the exact text; another tenant, a wrong id and no session do not
  const ok = await evidenceGET(get(`/api/leads/evidence?lead_id=${ids.copy}`)); assert.equal(ok.status, 200)
  const body = await ok.json() as { title: string; text: string; sha256: string; integrity: string; job_id: string; attempt: number; source_url: string; label: string }
  assert.equal(body.title, page.title); assert.equal(body.text, TEXT); assert.equal(body.integrity, 'ok'); assert.equal(body.job_id, job); assert.equal(body.attempt, 1); assert.equal(body.source_url, page.url); assert.match(body.label, /did not read the page directly/)
  assert.equal((await evidenceGET(get(`/api/leads/evidence?lead_id=${ids.plain}`))).status, 404, 'a lead without a copy has no evidence record')
  setUser({ id: 'B', business_name: 'Beta' }); assert.equal((await evidenceGET(get(`/api/leads/evidence?lead_id=${ids.copy}`))).status, 404)
  assert.equal((await exportGET(get(`/api/leads/export?job_id=${job}`)).then(r => r.text())).includes('CopyCo'), false)
  setUser(null); assert.equal((await evidenceGET(get(`/api/leads/evidence?lead_id=${ids.copy}`))).status, 401)
  // after an audited purge of tenant A's evidence: no link, no false availability; 410 says it was deleted; B is untouched
  setUser({ id: 'A', business_name: 'Acme' })
  const pre = await (await exportGET(get(`/api/leads/export?job_id=${job}`))).text(); assert.doesNotMatch(pre, /deleted at the account owner/)
  purgeTenantEvidence(db, { tenantId: 'A', confirmTenantId: 'A', operator: 'ops-jane', reason: 'Written deletion request, ticket 4411', execute: true })
  const gone = await evidenceGET(get(`/api/leads/evidence?lead_id=${ids.copy}`)); assert.equal(gone.status, 410)
  const gj = await gone.json() as { error: string; note: string; text?: string }; assert.equal(gj.error, 'purged'); assert.equal(gj.text, undefined); assert.match(gj.note, /deleted at the account owner's request/)
  const post = parseCsv(await (await exportGET(get(`/api/leads/export?job_id=${job}`))).text())
  assert.match(post.find(r => r['Company'] === 'CopyCo')![col], /copy of the page fetched by TinyFish.*deleted at the account owner's request.*can no longer be shown/)
  assert.doesNotMatch(post.find(r => r['Company'] === 'PlainCo')![col], /deleted/)
  const leadsBody = { leads: listLeads(db, 'A', job, 200, true) as { id: string; evidence_copy_id: string | null; evidence_purged_at: number | null }[] } // the rows /api/leads returns
  const l = leadsBody.leads.find(x => x.id === ids.copy)!; assert.equal(l.evidence_copy_id, null); assert.ok(l.evidence_purged_at)
})
