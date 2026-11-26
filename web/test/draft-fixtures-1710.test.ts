// #1710 verify slice: the draft builder run on five realistic Ready-lead fixtures. Test-only; it never edits the
// composer (lib/outreach/draft-copy.ts belongs to the #1718 lane, PR #1868). A draft must have no internal or system
// wording, the pitch of the SAVED business profile it was built for (never another seller's, never a pasted profile
// line), and a personal opener (first-name greeting, then the company or its signal named in the first paragraph).
// Fixtures are synthetic and nothing is sent; this proves the composer's output, not any live draft.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { composeDraftCopy } from '../lib/outreach/draft-copy.ts'

interface Fixture {
  key: string
  lead: { name: string | null; company: string; signal: string | null; evidence_excerpt: string | null; source_url: string }
  seller: string
  offer: string        // the saved profile line, as the product stores it
  pitchWords: string[] // words the draft must carry from that profile
  openerWords: string[] // at least one must appear in the opener paragraph
}

const F: Fixture[] = [
  { key: 'dentist', lead: { name: 'Dana Ruiz', company: 'Brightside Dental', signal: 'Brightside Dental is hiring a front desk coordinator', evidence_excerpt: 'Brightside Dental is hiring a front desk coordinator for its second office', source_url: 'https://brightsidedental.example/careers' },
    seller: 'ChairFill', offer: 'online booking and no-show reminders for dental practices', pitchWords: ['booking', 'reminders', 'dental'], openerWords: ['Brightside Dental', 'front desk'] },
  { key: 'commercial cleaner', lead: { name: 'Marcus Webb', company: 'Northgate Offices', signal: 'Northgate Offices opened a new 40,000 sq ft office building', evidence_excerpt: 'Northgate Offices opened a new 40,000 sq ft office building downtown', source_url: 'https://northgate.example/news/new-building' },
    seller: 'SparkClean', offer: 'Nightly commercial cleaning for office buildings', pitchWords: ['cleaning', 'office'], openerWords: ['Northgate Offices', 'new'] },
  { key: 'SaaS hiring SDRs', lead: { name: 'Priya Nair', company: 'Loopwave', signal: 'Loopwave is hiring three SDRs', evidence_excerpt: 'Loopwave is hiring three SDRs to build its outbound team', source_url: 'https://loopwave.example/jobs' },
    seller: 'Rampstack', offer: 'Trains new sales reps to full quota in half the time', pitchWords: ['sales reps', 'quota'], openerWords: ['Loopwave', 'SDR'] },
  { key: 'marketing agency', lead: { name: 'Tom Okafor', company: 'Brightpath Media', signal: 'Brightpath Media won a regional retail account', evidence_excerpt: 'Brightpath Media announced it won the regional retail account for a grocery chain', source_url: 'https://brightpath.example/blog/retail-win' },
    seller: 'Reportly', offer: 'Automated client reporting for marketing agencies', pitchWords: ['reporting', 'agencies'], openerWords: ['Brightpath Media', 'retail'] },
  // A public-sector lead is held until its date is verified: no excerpt, no dated signal. The draft, if one is
  // composed at all, must not invent a signal or fall back to system wording.
  { key: 'public-sector held lead', lead: { name: null, company: 'City of Fairview Public Works', signal: null, evidence_excerpt: null, source_url: 'https://fairview.example.gov/procurement' },
    seller: 'RouteSense', offer: 'Fleet routing software for municipal public works teams', pitchWords: ['routing', 'municipal'], openerWords: ['City of Fairview Public Works'] },
]

// Internal / system wording that must never reach a prospect.
const SYSTEM = [
  /Saved excerpt/i, /contact address published/i, /published on .*page/i, /About [^\n:]{1,60}:/, /https?:\/\//i, /\bwww\./i,
  /\bsource[_ ]url\b/i, /\benrichment/i, /\bconfidence\b/i, /\bfit score\b/i, /\blead[_ ]id\b/i, /\bnull\b|\bundefined\b|\[object /i,
  /\{\{|\}\}|\bTODO\b|\bplaceholder\b/i, /public page/i, /saved (text|signal|quote)/i,
]

for (const f of F) {
  test(`${f.key}: no system wording, the saved profile's pitch, a personal opener`, () => {
    const d = composeDraftCopy(f.lead, f.seller, f.offer)
    const all = `${d.subject}\n${d.body}`
    for (const re of SYSTEM) assert.doesNotMatch(all, re, `${f.key}: internal wording ${re} in the draft`)
    // pitch: the seller's own profile, framed as a sentence, never pasted raw, never another fixture's offer
    assert.ok(d.body.includes(`At ${f.seller}`), `${f.key}: the pitch names the saved business (${f.seller})`)
    for (const w of f.pitchWords) assert.ok(d.body.toLowerCase().includes(w.toLowerCase()), `${f.key}: the pitch carries "${w}" from the saved profile`)
    assert.ok(!d.body.includes(f.offer) || d.body.includes(`we offer ${f.offer}`) || /^At /m.test(d.body), `${f.key}: the profile line is framed, not pasted`)
    // Another seller's pitch words are checked in the pitch paragraph only (the opener may legitimately repeat the
    // lead's own words, e.g. "second office" for a dentist).
    const pitch = d.body.split('\n\n').find(p => p.startsWith(`At ${f.seller}`)) ?? ''
    assert.ok(pitch, `${f.key}: there is a pitch paragraph`)
    for (const other of F) if (other !== f) for (const w of other.pitchWords) {
      if (f.pitchWords.some(p => p.toLowerCase() === w.toLowerCase())) continue
      assert.ok(!pitch.toLowerCase().includes(w.toLowerCase()), `${f.key}: the pitch carries "${w}", another seller's pitch`)
    }
    // personal opener: first-name greeting (or "there" when no name), then the company or its signal in the first paragraph
    const [greeting, opener] = d.body.split('\n\n')
    assert.equal(greeting, `Hi ${f.lead.name ? f.lead.name.split(' ')[0] : 'there'},`, `${f.key}: greeting`)
    assert.ok(opener && f.openerWords.some(w => opener.toLowerCase().includes(w.toLowerCase())), `${f.key}: the opener names the company or its signal, got "${opener}"`)
    assert.doesNotMatch(opener ?? '', /^I'?m writing to/i, `${f.key}: the opener is not the template's contact-address line`)
    if (!f.lead.evidence_excerpt) assert.doesNotMatch(opener ?? '', /hiring|opened|won|announced/i, `${f.key}: no signal is invented when none was saved`)
  })
}

// The live builder: createDraft must compose through the composer, not the old template that wrote the system wording.
test('createDraft builds its draft with composeDraftCopy, not the legacy draftTemplate', () => {
  const src = readFileSync(new URL('../lib/outreach/service.ts', import.meta.url), 'utf8')
  const inner = src.slice(src.indexOf('function createDraftInner'))
  const body = inner.slice(0, inner.indexOf('\n}\n'))
  assert.match(body, /composeDraftCopy\(/, 'createDraftInner calls the composer')
  assert.doesNotMatch(body, /draftTemplate\(/, 'createDraftInner no longer calls the legacy template')
})
