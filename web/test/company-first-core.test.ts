import assert from 'node:assert/strict'
import { before, after, mock, test } from 'node:test'
import { runCompanyFirst, type Candidate, type CompanyFirstPorts, type Reservation } from '../lib/company-first/company-first-evidence.ts'

before(()=>{mock.method(Date,'now',()=>Date.parse('2026-09-26T12:00:00Z'))})
after(()=>mock.restoreAll())

const scope = { tenant: 'private-tenant', job: 'private-job', attempt: 'private-attempt' }
const criteria = { category: 'sector-key', place: 'canonical-place-key', event: 'open-role', from: '2026-09-01', through: '2026-09-30' }
const candidate = { name: 'Example Company', hintUrl: 'https://listing.example/item?private=1#secret' }
const site = { status: 'verified' as const, candidateName: candidate.name, companyKey: 'example-company', website: 'https://company.example/', identitySource: 'https://company.example/about' }
const posting = 'https://job-boards.greenhouse.io/example/jobs/100'
const quote = 'This company is hiring an Account Executive.'
const signal = { companyKey: site.companyKey, event: criteria.event, place: criteria.place, date: '2026-09-15', sourceUrl: 'https://company.example/careers/item', quote, literalSourceText: `Context here. ${quote} Additional content. 15 September 2026`, dateProof: { kind: 'first_party_event_date' as const, sourceUrl: 'https://company.example/careers/item', day: '2026-09-15', literalDate: '15 September 2026' } }
const on = { enabled: true }

function fake(overrides: Partial<CompanyFirstPorts> = {}) {
  const trace: unknown[] = []
  const ports: CompanyFirstPorts = {
    async reserveBeforeDispatch(r) { trace.push(['reserve', r.stage, r.scope, r.ordinal]); return true },
    async isCurrent(s) { trace.push(['current', s]); return true },
    async discover(x) { trace.push(['discover', x.input]); return [candidate] },
    async verifyWebsite(x) { trace.push(['website', x.input]); return site },
    async verifyDatedSignal(x) { trace.push(['signal', x.input]); return signal },
    ...overrides,
  }
  return { trace, ports }
}

test('disabled by default and invalid criteria cause zero reservations and provider calls', async () => {
  const { ports, trace } = fake()
  assert.deepEqual(await runCompanyFirst({}, scope, criteria, ports), { state: 'disabled', findings: [] })
  assert.deepEqual(await runCompanyFirst(on, scope, { ...criteria, from: '2026-02-30' }, ports), { state: 'invalid', findings: [] })
  assert.deepEqual(trace, [])
})

test('reserves strictly before each stage and shares only minimal stage data', async () => {
  const { ports, trace } = fake()
  const report = await runCompanyFirst(on, scope, criteria, ports)
  assert.equal(report.findings[0]?.state, 'signal_verified')
  assert.deepEqual(trace, [
    ['reserve', 'discover', scope, 0], ['discover', { category: criteria.category, place: criteria.place }],
    ['reserve', 'website', scope, 1], ['website', { name: candidate.name, hintUrl: 'https://listing.example/item' }],
    ['reserve', 'signal', scope, 2], ['signal', { companyKey: site.companyKey, websiteOrigin: 'https://company.example', event: criteria.event, place: criteria.place, from: criteria.from, through: criteria.through }],
    ['current', scope],
  ])
  assert.equal(JSON.stringify(report).includes('Additional content'), false)
  assert.equal(JSON.stringify(report).includes('private'), false)
})

test('denied or failed reservations never dispatch their provider operation', async () => {
  for (const stage of ['discover', 'website', 'signal'] as const) {
    const tried: string[] = []
    const { ports } = fake({
      async reserveBeforeDispatch(r: Reservation) { if (r.stage === stage) throw Error('unavailable'); return true },
      async discover() { tried.push('discover'); return [candidate] },
      async verifyWebsite() { tried.push('website'); return site },
      async verifyDatedSignal() { tried.push('signal'); return signal },
    })
    const report = await runCompanyFirst(on, scope, criteria, ports)
    const stages = ['discover', 'website', 'signal']
    assert.deepEqual(tried, stages.slice(0, stages.indexOf(stage)))
    if (stage === 'discover') assert.equal(report.state, 'discovery_unavailable')
    else assert.deepEqual(report.findings, [{ state: 'held', reason: 'reservation_unavailable', count: 1 }])
  }
})

test('unknown company and duplicate normalized names/key/site never start signal verification', async () => {
  for (const [candidates, resolve, reason] of [
    [[candidate], () => ({ ...site, identitySource: 'https://lookalike.example/about' }), 'identity_unknown'],
    [[candidate, { name: 'example company' }], () => site, 'duplicate_company'],
    [[candidate, { name: 'Other Label' }], (c: Candidate) => ({ ...site, candidateName: c.name, companyKey: c.name }), 'duplicate_company'],
    [[candidate, { name: 'Another Label' }], (c: Candidate) => ({ ...site, candidateName: c.name, companyKey: c.name === candidate.name ? 'EXAMPLE-KEY' : 'example-key', website: c.name === candidate.name ? site.website : 'https://other.example', identitySource: c.name === candidate.name ? site.identitySource : 'https://other.example/about' }), 'duplicate_company'],
  ] as const) {
    const { ports, trace } = fake({ async discover() { return candidates }, async verifyWebsite({ input }) { return resolve(input) } })
    const report = await runCompanyFirst(on, scope, criteria, ports)
    assert.deepEqual(report.findings, [{ state: 'held', reason, count: candidates.length }])
    assert.ok(!trace.some(x => Array.isArray(x) && x[0] === 'signal'))
  }
})

test('an exact ATS posting is accepted only when linked from that verified origin', async () => {
  for (const mode of ['ok', 'wrong_identity', 'wrong_source', 'wrong_id', 'wrong_host', 'root'] as const) {
    const seen: (string | undefined)[] = []
    const { ports } = fake({
      async verifyWebsite() { return { ...site, posting: { linkSource: mode === 'wrong_source' ? 'https://third-party.example/listing' : site.identitySource, postingUrl: mode === 'root' ? 'https://job-boards.greenhouse.io/example' : posting } } },
      async verifyDatedSignal({ input }) {
        seen.push(input.postingUrl)
        return { ...signal, dateProof: { kind: 'ats_first_published', sourceUrl: posting, day: signal.date }, companyKey: mode === 'wrong_identity' ? 'another-company' : signal.companyKey, sourceUrl: mode === 'wrong_id' ? posting.replace('/100','/200') : mode === 'wrong_host' ? posting.replace('.io/', '.io.third-party.example/') : posting }
      },
    })
    assert.equal((await runCompanyFirst(on, scope, criteria, ports)).findings[0]?.state, mode === 'ok' ? 'signal_verified' : 'held', mode)
    assert.deepEqual(seen, [mode === 'wrong_source' || mode === 'root' ? undefined : posting])
  }
})

test('wrong place/event/date and stitched quote stay held, no evidence on supersession/cancel', async () => {
  for (const mismatch of [{ place: 'other-place' }, { event: 'other-event' }, { date: '2026-10-01' }, { date: '2026-09-31' }, { literalSourceText: 'This company is hiring. Account Executive.' }]) {
    const { ports } = fake({ async verifyDatedSignal() { return { ...signal, ...mismatch } } })
    assert.deepEqual((await runCompanyFirst(on, scope, criteria, ports)).findings, [{ state: 'held', reason: 'signal_unknown', count: 1 }])
  }
  const { ports } = fake({ async isCurrent() { return false } })
  assert.deepEqual(await runCompanyFirst(on, scope, criteria, ports), { state: 'superseded_or_expired', findings: [] })
  const abort = new AbortController()
  const aborted = fake({ async reserveBeforeDispatch() { abort.abort(); return true } })
  assert.deepEqual(await runCompanyFirst({ ...on, signal: abort.signal }, scope, criteria, aborted.ports), { state: 'superseded_or_expired', findings: [] })
  assert.deepEqual(aborted.trace, [])
})

test('a transport rejection stops all later dispatch while a known empty proof remains a hold', async () => {
  for (const shouldReject of [true, false]) {
    const offered: string[] = []
    const { ports } = fake({
      async discover() { return [candidate, { name: 'Second company' }] },
      async verifyWebsite({ input }) {
        offered.push(input.name)
        if (input.name === candidate.name && shouldReject) throw Error('transport usage unknown')
        return null
      },
    })
    const report = await runCompanyFirst(on, scope, criteria, ports)
    assert.deepEqual(offered, shouldReject ? [candidate.name] : [candidate.name, 'Second company'])
    assert.deepEqual(report.findings, shouldReject
      ? [{ state: 'held', reason: 'identity_unknown', count: 1 }, { state: 'held', reason: 'reservation_unavailable', count: 1 }]
      : [{ state: 'held', reason: 'identity_unknown', count: 2 }])
  }
})

test('seven reviewed candidates can yield five verified signals and two anonymous holds under a separate allowance', async () => {
  const candidates: Candidate[] = Array.from({ length: 7 }, (_, i) => ({ name: `Synthetic company ${i}` }))
  const own = (companyKey: string) => `https://org-${companyKey}.example`
  const reservations: string[] = []
  const allowance = 14 // one discovery, seven identities, six signal reads; external authority.
  const guard = new AbortController()
  const { ports } = fake({
    async reserveBeforeDispatch(r) { reservations.push(r.stage); assert.equal(r.signal.aborted, false); return reservations.length <= allowance },
    async discover() { return candidates },
    async verifyWebsite({ input }) {
      const index = candidates.findIndex(c => c.name === input.name)
      if (index === 0) return null
      const companyKey = String(index)
      return { ...site, candidateName: input.name, companyKey, website: own(companyKey), identitySource: own(companyKey) + '/about' }
    },
    async verifyDatedSignal({ input }) {
      if (input.companyKey === '1') return null
      const sourceUrl = own(input.companyKey) + '/events/signal'
      return { ...signal, companyKey: input.companyKey, sourceUrl, dateProof: { ...signal.dateProof, sourceUrl } }
    },
  })
  const result = await runCompanyFirst({ ...on, signal: guard.signal }, scope, criteria, ports)
  assert.equal(reservations.length, allowance)
  assert.equal(result.findings.filter(x => x.state === 'signal_verified').length, 5)
  assert.deepEqual(result.findings.filter(x => x.state === 'held'), [
    { state: 'held', reason: 'identity_unknown', count: 1 }, { state: 'held', reason: 'signal_unknown', count: 1 },
  ])
  const json = JSON.stringify(result)
  assert.equal(json.includes(candidates[0].name), false)
  assert.equal(json.includes(candidates[1].name), false)
})

test('overfull discovery fails closed and citation/date receipts cannot substitute another source or date basis', async () => {
  const over = fake({ async discover() { return Array(21).fill(candidate) } })
  assert.deepEqual(await runCompanyFirst(on, scope, criteria, over.ports), { state: 'discovery_unavailable', findings: [] })
  assert.equal(over.trace.length, 1)
  for (const dateProof of [
    { ...signal.dateProof, sourceUrl: 'https://company.example/other' },
    { ...signal.dateProof, day: '2026-09-16' },
    { ...signal.dateProof, literalDate: '16 September 2026' },
    { kind: 'ats_first_published' as const, sourceUrl: signal.sourceUrl, day: signal.date },
  ]) {
    const { ports } = fake({ async verifyDatedSignal() { return { ...signal, dateProof } } })
    assert.deepEqual((await runCompanyFirst(on, scope, criteria, ports)).findings, [
      { state: 'held', reason: 'signal_unknown', count: 1 },
    ])
  }
})

test('external deadline while a website port is active denies later reservation and discards output', async () => {
  const guard = new AbortController()
  const { ports, trace } = fake({
    async verifyWebsite({ signal: active }) {
      guard.abort()
      assert.equal(active.aborted, true)
      return site // a late response cannot advance the state
    },
  })
  assert.deepEqual(await runCompanyFirst({ ...on, signal: guard.signal }, scope, criteria, ports),
    { state: 'superseded_or_expired', findings: [] })
  assert.deepEqual(trace.map(x => Array.isArray(x) ? x.slice(0, 2) : x), [
    ['reserve', 'discover'], ['discover', { category: criteria.category, place: criteria.place }], ['reserve', 'website'],
  ])
})


test('a broad brief cannot bypass the absolute UTC 45-day signal cap',async()=>{
 const now=Date.now()
 for(const age of [45,46,-1]){
   const date=new Date(now-age*86_400_000).toISOString().slice(0,10)
   const {ports}=fake({async verifyDatedSignal(){return {...signal,date,dateProof:{...signal.dateProof,day:date,literalDate:date},
     literalSourceText:signal.quote+' '+date}}})
   const r=await runCompanyFirst(on,scope,{...criteria,from:'2000-01-01',through:'2999-12-31'},ports)
   assert.equal(r.findings.some(f=>f.state==='signal_verified'),age===45,String(age))
 }
})
