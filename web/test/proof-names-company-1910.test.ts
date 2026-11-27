// #1910 offline slice, the source side of the shown rule: a lead is kept when its proof page NAMES the company, and a
// proof about some other company is never attributed to it. postingQuote is that check in lib/signals/careers-page.ts
// (the careers adapter's namedQuote evidence): it widens the quote to the company name and returns nothing when it cannot.
import test from 'node:test'
import assert from 'node:assert/strict'
import { postingQuote } from '../lib/signals/careers-page.ts'

const ROLE = 'Service Manager'

test('#1910 a proof that names the company keeps a quote that says so', () => {
  const q = postingQuote(['Brightloop HVAC is hiring a Service Manager to lead field crews.'], ROLE, 'Brightloop HVAC')
  assert.ok(q.length >= 20, 'a named proof yields a quote')
  assert.match(q, /Brightloop HVAC/i, 'the quote carries the company name')
  assert.doesNotMatch(q, /undefined|null|\[object/i)
})

test('#1910 a proof about another company is never attributed to this one', () => {
  const q = postingQuote(['Northwind Heating is hiring a Service Manager to lead field crews.'], ROLE, 'Brightloop HVAC')
  assert.equal(q, '', 'a quote naming only another company is not this lead proof')
})

test('#1910 a proof that names no company never gets the name added to it', () => {
  // postingQuote widens the window to the name only when it is there; the adapter's namedQuote check is what refuses the
  // quote entirely. What must never happen is the name appearing in a quote the proof does not contain.
  const q = postingQuote(["We're hiring a Service Manager to lead field crews."], ROLE, 'Brightloop HVAC')
  assert.doesNotMatch(q, /Brightloop/i, 'no company name is invented into the quote')
  const loose = postingQuote(["We're hiring a Service Manager to lead field crews."], ROLE, 'Brightloop HVAC', false)
  assert.ok(loose.length >= 20, 'the plain title window still quotes')
  assert.doesNotMatch(loose, /Brightloop/i, 'and still does not invent the name')
})

test('#1910 a board or trading name the posting uses counts as naming the company', () => {
  const q = postingQuote(['Brightloop is hiring a Service Manager to lead field crews.'], ROLE, 'Brightloop HVAC', true, ['Brightloop'])
  assert.ok(q.length >= 20, 'the org name names it')
  assert.match(q, /Brightloop/i)
})

// The five search shapes: the same rule must hold whatever the role or the industry, and must not depend on them.
const shapes: { query: string; company: string; role: string; proof: string; other: string }[] = [
  { query: 'Dentists in Mississauga', company: 'Mississauga Smile Studio', role: 'Office Manager', proof: 'Mississauga Smile Studio is hiring an Office Manager for its Erindale clinic.', other: 'Credit Valley Dental is hiring an Office Manager.' },
  { query: 'Commercial cleaning in Toronto', company: 'Northline Facility Care', role: 'Operations Lead', proof: 'Northline Facility Care is hiring an Operations Lead to run night shifts.', other: 'Eglinton Building Services is hiring an Operations Lead.' },
  { query: 'Marketing agencies in Austin', company: 'Cedar Pratt Creative', role: 'Founder', proof: 'Cedar Pratt Creative is hiring a Founder to lead its new retail practice.', other: 'Barton Growth is hiring a Founder.' },
  { query: 'Accountants in Calgary', company: 'Ridgeline Accounting', role: 'Managing Partner', proof: 'Ridgeline Accounting is hiring a Managing Partner in Calgary.', other: 'Bow Valley Ledgers is hiring a Managing Partner.' },
  { query: 'HVAC companies in Denver', company: 'Brightloop HVAC', role: 'Service Manager', proof: 'Brightloop HVAC is hiring a Service Manager to lead field crews.', other: 'Northwind Heating is hiring a Service Manager.' },
]

for (const s of shapes) {
  test(`#1910 ${s.query}: its own proof is kept, another company's is not`, () => {
    const own = postingQuote([s.proof], s.role, s.company)
    assert.ok(own.length >= 20, 'own proof yields a quote')
    assert.match(own.toLowerCase(), new RegExp(s.company.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the quote names the company')
    assert.equal(postingQuote([s.other], s.role, s.company), '', 'another company proof is dropped')
  })
}

test('company-authored vacancy proof preserves punctuation and legal suffixes verbatim', () => {
  for (const [company, printed, role] of [
    ['Cedar & Pratt', 'Cedar & Pratt', 'Founder'],
    ['Smith & Sons HVAC', 'Smith & Sons HVAC', 'Service Manager'],
    ['Acme Inc.', 'Acme Inc.', 'Founder'],
    ['Acme', 'Acme Inc.', 'Founder'],
  ]) {
    const line = `${printed} is hiring a ${role} to lead its new practice.`
    assert.equal(postingQuote([line], role, company), line)
    assert.equal(postingQuote([`Other ${line}`], role, company), '')
  }
})

test('role headings and opening quotation marks preserve the employer subject', () => {
  for (const prefix of ['The opportunity ', 'The role: “', '“']) {
    const statement = 'Brightloop is hiring an Account Executive to own the sales pipeline.'
    const line = prefix + statement
    assert.equal(postingQuote([line], 'Account Executive', 'Brightloop'), line)
    assert.equal(postingQuote([prefix + 'Other ' + statement], 'Account Executive', 'Brightloop'), '')
  }
})
