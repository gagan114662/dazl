import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveOffer, draftOffer } from '../lib/scan/play-offer-text.ts'

// #349 withdrawal classes. Each class is a rule, proved on several variants; every variant also goes through draftOffer
// (the drafting, rewrite and scoring entry), which must refuse while the play is unresolved.
const seller = (s: string) => `${s} - https://seller.example`
const conflictOf = (saved: string, q: string) => {
  const r = effectiveOffer({ seller: seller(saved), query: q }, '')
  return { r, refused: draftOffer({ seller: seller(saved), query: q }, '').offer === null }
}

// A. A withdrawal that names the saved product anywhere, also inside a term clause ("support for payroll software"),
//    withdraws it: the play waits for a choice. Terms that leave the saved product unnamed still resolve.
const PAYROLL = 'Payroll software to restaurants.'
const CLASS_A = [
  'We no longer sell support for payroll software.',
  "We don't offer training on our payroll software.",
  'We no longer provide onboarding for the payroll platform.',
  'We have stopped offering discounts on payroll software.',
  'We do not offer free trials of payroll software.',
  "We can't offer warranties for payroll software anymore.",
  'We no longer provide live chat support for payroll software.',
  'Note: we no longer offer custom pricing for payroll.',
]
const CLASS_A_TERMS_ONLY = ["We don't offer refunds to restaurants.", 'We do not offer free trials.', "We don't offer discounts.", 'We no longer offer phone support.', 'We do not provide on-site training to restaurants.']

// B. Plural and singular forms are one word, regular or not (warranty/warranties, delivery/deliveries, class/classes,
//    batch/batches, policy/policies), on either side.
const CLASS_B: [saved: string, q: string][] = [
  ['Warranty administration for retailers.', 'We no longer offer warranties.'],
  ['Extended warranties for electronics shops.', 'We no longer sell warranty.'],
  ['Same-day deliveries for florists.', 'We no longer offer delivery.'],
  ['Delivery for restaurants.', 'We do not offer deliveries.'],
  ['Coaching classes for founders.', 'We no longer offer class.'],
  ['Weekend classes for agencies.', 'We have stopped offering weekend class.'],
  ['Return policies for online shops.', 'We no longer sell return policy.'],
  ['Live chat support for shops.', 'We no longer offer live chats.'],
  ['Payment processing for restaurants.', 'We no longer provide payments.'],
]

// C. A replacement named after the withdrawal, joined by a comma, a semicolon, a dash or a conjunction, or in the next
//    sentence, is the stated offer the chooser offers (never the withdrawn text, never dropped).
const P = 'appointment booking and reminder software'
const DENTAL = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const CRM = 'CRM setup and outbound consulting'
const CLASS_C = [
  `We do not sell ${P} anymore, we now sell ${CRM}.`,
  `We no longer sell ${P}; instead we sell ${CRM}.`,
  `We no longer sell ${P} - we now offer ${CRM}.`,
  `We stopped selling ${P}, now we sell ${CRM}.`,
  `We don't sell ${P} any more but we do sell ${CRM}.`,
  `We no longer sell ${P} and instead offer ${CRM}.`,
  `We no longer sell ${P}, only ${CRM}.`,
  `We no longer sell ${P}. Now we sell ${CRM}.`,
]

test('#349 class A: a withdrawal naming the saved product anywhere is a choice; terms that leave it unnamed resolve', () => {
  const failures: string[] = []
  for (const q of CLASS_A) {
    const { r, refused } = conflictOf(PAYROLL, q)
    if (r.source !== 'conflict' || r.conflict?.stated !== null || !refused) failures.push(`${q} -> ${r.source}`)
  }
  for (const q of CLASS_A_TERMS_ONLY) {
    const { r } = conflictOf(PAYROLL, q)
    if (r.source !== 'recorded') failures.push(`terms only: ${q} -> ${r.source}`)
  }
  assert.deepEqual(failures, [])
})

test('#349 class B: singular and plural forms (regular or not) of the saved product are one word', () => {
  const failures: string[] = []
  for (const [saved, q] of CLASS_B) {
    const { r, refused } = conflictOf(saved, q)
    if (r.source !== 'conflict' || !refused) failures.push(`${saved} / ${q} -> ${r.source}`)
  }
  assert.deepEqual(failures, [])
})

test('#349 class C: a replacement after the withdrawal is the stated offer; the withdrawn text is the dental product', () => {
  const failures: string[] = []
  for (const q of CLASS_C) {
    const { r, refused } = conflictOf(DENTAL, q)
    const ok = r.source === 'conflict' && r.conflict?.stated === CRM && r.conflict?.withdrawn === P && refused
    if (!ok) failures.push(`${q} -> ${r.source} stated=${JSON.stringify(r.conflict?.stated)} withdrawn=${JSON.stringify(r.conflict?.withdrawn)}`)
  }
  assert.deepEqual(failures, [])
})

test("#349 Instinct's exact readbacks at ebee1ae: a qualified or ambiguous term exclusion is a choice through the caller paths", () => {
  for (const [saved, q] of [['We sell payroll software.', 'We no longer sell support for payroll software.'], ['We sell warranty management software.', 'We no longer sell warranties.']]) {
    const { r, refused } = conflictOf(saved, q)
    assert.equal(r.source, 'conflict', `${saved} / ${q}`); assert.equal(r.conflict!.stated, null); assert.ok(refused, 'draftOffer refuses')
    // the profile path too
    assert.equal(effectiveOffer({ seller: null, query: q }, saved).source, 'conflict', `profile: ${q}`)
  }
})
