// Synthetic provider-boundary fixtures through the real runner and readers; no live yield claim.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { runFixture, daysAgo } from './helpers/acceptance-harness.ts'
import { listLeads } from '../lib/scan/store.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { identityOf } from '../lib/scan/opportunity.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import { workEmailTargets, targetKey } from '../lib/people/work-email-eligible.ts'
import { findWorkEmail, workEmailPageRead } from '../lib/people/work-email.ts'
import { mailboxCheckUsage } from '../lib/people/verify-usage.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { verifiedLeads } from '../lib/scan/first5.ts'

const SITE = 'brightloop.example', SRC = `https://${SITE}/news/seed`
const DAY = daysAgo(5)
const QUOTE = 'Brightloop, a Chicago B2B SaaS startup, raised a seed funding round to expand its software platform'
const TEXT = `On ${DAY}, ${QUOTE}. ${'Brightloop makes software for business teams in Chicago, Illinois, United States. '.repeat(8)}`
const ICP = { summary: 'B2B SaaS startups', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['Chicago, Illinois, United States'], signals: ['announced seed funding'], exclude: [], country: 'US', language: 'en', window_days: 90 }
const ENV = { SITECRAWL_ENABLED: '1', PEOPLE_SEARCH_ENABLED: '1', EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '1', EMAIL_VERIFY_MONTHLY_CAP: '2', ZEROBOUNCE_API_KEY: 'fixture-only' }
async function withEnv<T>(f: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]])); Object.assign(process.env, ENV); // every old guess/check input is on: none of them is used
  try { return await f() } finally { for (const [k,v] of Object.entries(old)) { if(v === undefined) delete process.env[k]; else process.env[k] = v } }
}

export async function launchFixture() {
  const pages: Record<string,string> = {
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': `<html><title>Brightloop</title><p>${TEXT}</p><p>Brightloop, 100 Example Avenue, Chicago, IL 60601</p><a href="/team">Our team</a><a href="/contact">Contact</a></html>`,
    '/team': `<html><p>${TEXT}</p><h3>Dana Lee</h3><p>Founder</p><div data-search-string="Pat Kim pat.kim@${SITE}"><h3>Pat Kim</h3><p>Founder</p></div><div data-search-string="Sue Ray sue.ray@${SITE}"><h3>Sue Ray</h3><p>Founder</p></div></html>`,
    '/contact': `<html><p>${TEXT}</p><p>Brightloop, 100 Example Avenue, Chicago, IL 60601</p></html>`,
    '/news/seed': `<html><p>${TEXT}</p></html>`,
  }
  const crawlReads: string[] = [], providerCalls: string[] = []
  const r = await runFixture({ request: 'Find B2B SaaS startups in Chicago that announced seed funding in the past 90 days', modelIcp: ICP,
    modelQueries: ['Chicago SaaS seed funding'], hits: [{url:SRC,title:'Brightloop raises seed funding',snippet:QUOTE,date:DAY}],
    tfPages: {[SRC]: {title:'Brightloop raises seed funding',text:TEXT}}, own: {[SRC]: {title:'Brightloop raises seed funding',text:TEXT}},
    extraction: [{company:'Brightloop',signal:'raised seed funding',source_url:SRC,excerpt:QUOTE,event_date:DAY}],
    runBudget: JSON.stringify({first5:true,paid_fallback:false,credit_enrichment:false}),
    deps: { newsHttp: async () => ({status:200,body:JSON.stringify({articles:[{url:SRC,title:'Brightloop raises seed funding',seendate:DAY.replaceAll('-','')+'T100000Z'}]})}),
      crawlGet: async (u: string) => { crawlReads.push(u); const body = new URL(u).hostname === SITE ? pages[new URL(u).pathname] : undefined; return {status:body===undefined?404:200,body:body??'',finalUrl:u} }, crawlGapMs:0 },
  })
  const jobId = (r.db.prepare('SELECT id FROM scan_jobs').get() as {id:string}).id
  const leads = listLeads(r.db,'A',jobId) as { id: string; contact: string | null; company: string; review_reason: string | null }[]
  const lead = leads[0]!
  const enr = enrichmentsForLeads(r.db,'A',leads.map(l=>l.id))
  const rows = enr[lead.id] ?? []
  const site = identityOf({id:lead.id,contact:lead.contact},rows)
  const people = workEmailTargets(rows,'Founder',Date.now(),site)
  const target = people.find(p=>p.name==='Dana Lee')
  const fixtureFetch = (async (u: RequestInfo | URL) => {
    const url = new URL(String(u)); assert.equal(url.hostname,'api.zerobounce.net','only the verifier fixture may be called'); providerCalls.push(String(u));
    return new Response(JSON.stringify({status:'valid',sub_status:'',email:url.searchParams.get('email')}),{status:200})
  }) as typeof fetch
  return {r,jobId,leads,lead,enr,rows,site,people,target,providerCalls,fixtureFetch,crawlReads}
}

test('#1036 #1250 real first-play runner -> ready named US lead -> one click on a buyer the site prints no address for: no guess shown or used, no check, no call', async () => withEnv(async () => {
  const s = await launchFixture()
  assert.equal(s.r.r,'done'); assert.equal(s.lead.review_reason,null,'must genuinely pass ready gates')
  assert.equal(verifiedLeads(s.r.db,'A',s.jobId).length,1)
  assert.equal(s.site?.state,'fact'); assert.ok(s.target,'the real crawl stored the buyer')
  assert.equal(leadPerson(s.rows,'Founder',Date.now(),s.site),null,'#1037: a team-page person with no page-linked LinkedIn is not the lead\'s named buyer')
  const report = JSON.parse((s.r.db.prepare('SELECT report FROM scan_run_report').get() as {report:string}).report)
  assert.ok(report.enrichment.some((x:{stage:string;status:string})=>x.stage==='people_search' && ['ok','attempted_no_result'].includes(x.status)))
  // Pat Kim and Sue Ray print first.last addresses: the old flow learned that format and guessed Dana Lee's. Now nothing is built from it.
  const result = await findWorkEmail(s.r.db,'A',s.lead.id,targetKey(s.target!),{env:ENV,fetchImpl:s.fixtureFetch})
  const pageRead = workEmailPageRead(s.r.db,'A',s.leads)
  const usage = await mailboxCheckUsage(sqliteDb(s.r.db),'A',ENV)
  if(process.env.CONTACTS_RECEIPT) writeFileSync(process.env.CONTACTS_RECEIPT,JSON.stringify({synthetic:true,jobId:s.jobId,leads:s.leads.map(l=>({...l,enrichments:s.enr[l.id]})),site:s.site,targets:s.people.map(p=>({key:targetKey(p),name:p.name,title:p.title})),result,pageRead,usage,report,crawlReads:s.crawlReads,providerCalls:s.providerCalls},null,2))
  assert.ok('row' in result); assert.deepEqual([result.status,result.row.address],['not_found',null],JSON.stringify(result))
  assert.equal('guess' in result,false,'no guess is returned')
  assert.equal(s.providerCalls.length,0,'no mailbox check and no provider call')
  assert.equal(usage.day.used,0)
  assert.equal(s.r.db.prepare("SELECT count(*) FROM email_candidates WHERE tier = 'guessed'").pluck().get(),0,'no guessed candidate is written')
  const stored = s.r.db.prepare('SELECT contact FROM leads WHERE id = ?').get(s.lead.id) as {contact: string | null}
  assert.equal(stored.contact,s.lead.contact,'no new recipient authority')
  assert.deepEqual(pageRead.guesses[s.lead.id],undefined,'the Leads page shows no guess')
  assert.ok(!JSON.stringify(pageRead).includes(`dana.lee@${SITE}`),'the guessed address appears nowhere on the page read')
  // the buyers whose own address the site prints get exactly that address, from the page it is printed on
  const pat = s.people.find(p=>p.name==='Pat Kim'); assert.ok(pat,'the crawl stored Pat Kim as a buyer')
  const shown = await findWorkEmail(s.r.db,'A',s.lead.id,targetKey(pat),{env:ENV,fetchImpl:s.fixtureFetch})
  assert.ok('row' in shown); assert.deepEqual([shown.status,shown.row.address,shown.row.source_url],['published',`pat.kim@${SITE}`,`https://${SITE}/team`])
  assert.equal(s.providerCalls.length,0)
  assert.equal(listLeads(s.r.db,'B',s.jobId).length,0,'no cross-tenant leads')
  s.r.db.close()
}))
