import assert from 'node:assert/strict'
import test from 'node:test'
import { proveCompanyFirstContact, type CompanyFirstContactReaders, type OfficialBio, type OfficialDirectory, type PublicProfileCorroboration } from '../lib/company-first/company-first-contact-proof.ts'
import { runCompanyFirst, type Finding } from '../lib/company-first/company-first-evidence.ts'

const origin = 'https://sample-studio.example'
const bioUrl = origin + '/team/jane-quinn'
const linkedin = 'https://www.linkedin.com/in/jane-quinn-fixture'
const scope = { tenant: 'fixture-tenant', job: 'fixture-job', attempt: '1' }
const company = 'Sample Studio', name = 'Jane Quinn', title = 'Founder'
const success = { state: 'signal_verified', name: company,
  site: { companyKey: 'sample-studio', website: origin, identitySource: origin + '/' },
  signal: { companyKey: 'sample-studio', place: 'Synthetic Market', event: 'office_opening', date: '2026-11-01',
    sourceUrl: origin + '/news/office-opening', quote: 'Sample Studio opened an office in Synthetic Market.' },
} as const satisfies Finding

function fixture(edit: { directory?: Partial<OfficialDirectory>; bio?: Partial<OfficialBio>; profile?: Partial<PublicProfileCorroboration>; refuse?: 'directory' | 'bio' | 'profile'; staleAfter?: number; throws?: 'readDirectory' | 'readBio' | 'corroborateProfile' } = {}, expectedFinding: Finding = success) {
  const calls: string[] = []
  const touch = (step: typeof edit.throws, arg: string, exact: string) => {
    assert.equal(arg, exact)
    calls.push(String(step))
    if (edit.throws === step) throw new Error('private adapter data')
  }
  const reserves: string[] = []
  const readers: CompanyFirstContactReaders = {
    isCurrent: async (checkedScope, finding) => {
      assert.deepEqual(checkedScope, scope)
      assert.equal(finding, expectedFinding)
      return edit.staleAfter === undefined || calls.length < edit.staleAfter
    },
    reserveBeforeDispatch: async ({ scope: checkedScope, stage, signal }) => {
      assert.deepEqual(checkedScope, scope)
      assert.equal(signal.aborted, false)
      reserves.push(stage)
      return edit.refuse !== stage
    },
    readDirectory: async url => {
      touch('readDirectory', url, origin)
      const dirUrl = edit.directory?.url ?? origin + '/team'
      return { url: dirUrl, navigation: { sourceUrl: origin + '/', linkedUrl: dirUrl }, people: [{ name, title, bioUrl }], ...edit.directory }
    },
    readBio: async url => {
      touch('readBio', url, bioUrl)
      const text = edit.bio?.text ?? name + '\n' + title + '\nWork email: Jane.Quinn@sample-studio.example'
      const publications = text.split('\n').flatMap(literalLine => {
        const hit = /^(?:work email|email|courriel|電子メール|correo de trabajo) *: *(.+)$/i.exec(literalLine)
        return hit ? [{ named: edit.bio?.name ?? name, address: hit[1], literalLine }] : []
      })
      return { url: bioUrl, company, name, title, text, profiles: [{ url: linkedin, named: name }], publications, ...edit.bio }
    },
    corroborateProfile: async url => { touch('corroborateProfile', url, edit.profile?.url ?? linkedin); return { url: linkedin, company, name, title, current: true, ...edit.profile } },
  }
  return { readers, calls, reserves }
}

test('official director-linked bio, public-profile corroboration and literal published work address in order', async () => {
  const { readers, calls, reserves } = fixture()
  const result = await proveCompanyFirstContact(success, [title], scope, readers)
  assert.deepEqual(calls, ['readDirectory', 'readBio', 'corroborateProfile'])
  assert.deepEqual(reserves, ['directory', 'bio', 'profile'])
  assert.deepEqual(result, { status: 'contact_proof', buyer: { name, title, bioUrl, linkedin },
    published: { address: 'Jane.Quinn@sample-studio.example', sourceUrl: bioUrl } })
})

test('no buyer requests on unsupported/held signal or missing exact reviewed role', async () => {
  const { readers, calls } = fixture()
  for (const invalid of [
    null, { state: 'held', name: 'Private Name' },
    { ...success, signal: { ...success.signal, date: '2026-02-30' } },
    { ...success, signal: { ...success.signal, sourceUrl: 'https://boards.example/fixture/1' } },
    { ...success, site: { ...success.site, companyKey: 'other' } },
  ]) assert.deepEqual(await proveCompanyFirstContact(invalid as Finding | null, [title], scope, readers), { status: 'held', reason: 'missing_signal_proof' })
  assert.deepEqual(await proveCompanyFirstContact(success, [], scope, readers), { status: 'held', reason: 'missing_requested_role' })
  assert.deepEqual(calls, [])
})

test('fails closed at the first broken provenance or identity hop; holds never expose identity', async () => {
  for (const [edit, reason, sequence] of [
    [{ directory: { url: 'https://other.example/team' } }, 'directory_unavailable', ['readDirectory']],
    [{ directory: { people: [{ name, title, bioUrl }, { name, title: 'Director', bioUrl }] } }, 'buyer_unconfirmed', ['readDirectory']],
    [{ directory: { people: [{ name, title: 'Former Founder', bioUrl }] } }, 'buyer_unconfirmed', ['readDirectory']],
    [{ directory: { people: [{ name, title, bioUrl: 'https://other.example/jane-quinn' }] } }, 'bio_unconfirmed', ['readDirectory']],
    [{ bio: { url: 'https://other.example/jane-quinn' } }, 'bio_unconfirmed', ['readDirectory', 'readBio']],
    [{ bio: { title: 'Director' } }, 'bio_unconfirmed', ['readDirectory', 'readBio']],
    [{ bio: { text: 'Another Name\nFounder\nWork email: jane.quinn@sample-studio.example' } }, 'bio_unconfirmed', ['readDirectory', 'readBio']],
    [{ bio: { profiles: [{ named: 'Different Name', url: linkedin }] } }, 'profile_unconfirmed', ['readDirectory', 'readBio']],
    [{ bio: { profiles: [{ named: name, url: 'https://linkedin.com.example/in/jane-quinn' }] } }, 'profile_unconfirmed', ['readDirectory', 'readBio']],
    [{ profile: { company: 'Different Studio' } }, 'profile_unconfirmed', ['readDirectory', 'readBio', 'corroborateProfile']],
    [{ profile: { current: false } }, 'profile_unconfirmed', ['readDirectory', 'readBio', 'corroborateProfile']],
    [{ throws: 'corroborateProfile' }, 'profile_unconfirmed', ['readDirectory', 'readBio', 'corroborateProfile']],
  ] as const) {
    const { readers, calls } = fixture(edit)
    assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, readers), { status: 'held', reason })
    assert.deepEqual(calls, sequence)
  }
})

test('named email never inferred: missing, shared, unrelated, ambiguous and foreign addresses hold', async () => {
  for (const evidence of [
    '', 'Work email: info@sample-studio.example', 'Work email: another.person@sample-studio.example',
    'Work email: jane.quinn@different.example', 'Reach Jane at jane.quinn@sample-studio.example',
    'Work email: jane.quinn@sample-studio.example\nEmail: quinn.jane@sample-studio.example',
  ]) {
    const { readers } = fixture({ bio: { text: name + '\n' + title + '\n' + evidence } })
    assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, readers), { status: 'held', reason: 'email_unconfirmed' })
  }
})

test('reservation refusal, supersession and cancellation stop all later reads and discard identity', async () => {
  for (const [edit, expected] of [
    [{ refuse: 'directory' }, []],
    [{ refuse: 'bio' }, ['readDirectory']],
    [{ staleAfter: 2 }, ['readDirectory', 'readBio']],
    [{ staleAfter: 3 }, ['readDirectory', 'readBio', 'corroborateProfile']],
  ] as const) {
    const { readers, calls } = fixture(edit)
    assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, readers), { status: 'held', reason: 'contact_scope_unavailable' })
    assert.deepEqual(calls, expected)
  }
  const { readers, calls } = fixture()
  assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, readers, AbortSignal.abort()), { status: 'held', reason: 'contact_scope_unavailable' })
  assert.deepEqual(calls, [])
})

test('actual company-first core hands only a verified, dated own page into the contact stage', async () => {
  const { findings } = await runCompanyFirst({ enabled: true }, scope, {
    category: 'Synthetic Service', place: success.signal.place, event: success.signal.event,
    from: '2026-11-01', through: '2026-11-20',
  }, {
    reserveBeforeDispatch: async () => true,
    isCurrent: async () => true,
    discover: async () => [{ name: company }],
    verifyWebsite: async () => ({ status: 'verified', candidateName: company, ...success.site }),
    verifyDatedSignal: async () => ({ ...success.signal, literalSourceText: success.signal.quote + ' 1 November 2026',
      dateProof: { kind: 'first_party_event_date', sourceUrl: success.signal.sourceUrl, day: success.signal.date, literalDate: '1 November 2026' } }),
  })
  const found = findings[0]
  assert.deepEqual(found, success)
  const { readers } = fixture({}, found)
  assert.equal((await proveCompanyFirstContact(found, [title], scope, readers)).status, 'contact_proof')
})

test('a trusted directory link—not English path spelling—sets first-party directory scope', async () => {
  const localized = new URL('/équipe', origin).href
  const { readers } = fixture({ directory: { url: localized }, bio: { text: name + '\n' + title + '\nCourriel : jane.quinn@sample-studio.example' } })
  assert.equal((await proveCompanyFirstContact(success, [title], scope, readers)).status, 'contact_proof')
})

test('named mail published on the exact bio need not spell the full first and last name', async () => {
  const { readers } = fixture({ bio: { text: name + '\n' + title + '\nWork email: jquinn@sample-studio.example' } })
  assert.equal((await proveCompanyFirstContact(success, [title], scope, readers)).status, 'contact_proof')
})

test('an independently corroborated full name without inter-token spaces is not rejected', async () => {
  const named = '李小明'
  const { readers } = fixture({
    directory: { people: [{ name: named, title, bioUrl }] },
    bio: { name: named, text: named + ' (Xiaoming Li)\n' + title + '\n電子メール: xiaoming.li@sample-studio.example', profiles: [{url: linkedin, named}] },
    profile: { name: named },
  })
  assert.equal((await proveCompanyFirstContact(success, [title], scope, readers)).status, 'contact_proof')
})

test('translated directory label cannot replace a recorded exact own link or explicit mailbox publication', async () => {
  const url = new URL('/管理チーム', origin).href
  const missingLink = fixture({ directory: { url, navigation: { sourceUrl: 'https://other.example/', linkedUrl: url } } })
  assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, missingLink.readers), { status: 'held', reason: 'directory_unavailable' })
  assert.deepEqual(missingLink.calls, ['readDirectory'])
  const wrongLink = fixture({ directory: { url, navigation: { sourceUrl: origin + '/', linkedUrl: origin + '/other' } } })
  assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, wrongLink.readers), { status: 'held', reason: 'directory_unavailable' })
  const storedNoLetter = fixture({ bio: { publications: [{ named: name, address: 'jquinn@sample-studio.example', literalLine: 'Work email: jquinn@sample-studio.example' }] } })
  assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, storedNoLetter.readers), { status: 'held', reason: 'email_unconfirmed' })
  const wrongNamedPublication = fixture({ bio: { publications: [{ named: 'Another Name', address: 'Jane.Quinn@sample-studio.example', literalLine: 'Work email: Jane.Quinn@sample-studio.example' }] } })
  assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, wrongNamedPublication.readers), { status: 'held', reason: 'email_unconfirmed' })
})

test('abbreviated published mailbox must be uniquely named and is never a bare initial-free handle', async () => {
  for (const bad of ['jquinn', 'jq', 'quinn', 'sales']) {
    const { readers } = fixture({
      directory: { people: [{ name, title, bioUrl }, { name: 'John Quinn', title: 'Director', bioUrl: origin + '/team/john-quinn' }] },
      bio: { text: name + '\n' + title + '\nCorreo de trabajo: ' + bad + '@sample-studio.example' },
    })
    assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, readers), { status: 'held', reason: 'email_unconfirmed' })
  }
  const unspaced = fixture({ directory: { people: [{ name: 'Jane', title, bioUrl }] } })
  assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, unspaced.readers), { status: 'held', reason: 'buyer_unconfirmed' })
})

test('a regional LinkedIn hostname still requires the same exact current employer and title', async () => {
  const regional = 'https://pt.linkedin.com/in/jane-quinn-fixture'
  const fixtureFor = (currentTitle: string) => fixture({ bio: { profiles: [{ url: regional, named: name }] }, profile: { url: regional, title: currentTitle } })
  assert.equal((await proveCompanyFirstContact(success, [title], scope, fixtureFor(title).readers)).status, 'contact_proof')
  assert.deepEqual(await proveCompanyFirstContact(success, [title], scope, fixtureFor('Former Founder').readers), { status: 'held', reason: 'profile_unconfirmed' })
})
