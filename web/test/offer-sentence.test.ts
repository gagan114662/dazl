// #349: an offer quoted inside a sentence never doubles its punctuation (lib/offer-sentence.ts), and every place the app
// quotes a value in a sentence goes through that rule. Pure; no I/O beyond reading app/ sources.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inSentence } from '../lib/offer-sentence.ts'

// [as stored, as quoted mid-sentence]; the sentence supplies what follows ("..., but it started with <X>. dazl ...")
const VARIANTS: [string, string][] = [
  ['We sell CRM setup to founders.', 'We sell CRM setup to founders'],
  ['We sell CRM setup!', 'We sell CRM setup'],
  ['Do we sell CRM setup?', 'Do we sell CRM setup'],
  ['We sell CRM setup...', 'We sell CRM setup'],
  ['We sell CRM setup…', 'We sell CRM setup'],
  ['We sell CRM setup.  ', 'We sell CRM setup'],
  ['We sell "CRM setup."', 'We sell "CRM setup"'],
  ['We sell CRM setup (and audits.)', 'We sell CRM setup (and audits)'],
  ['We sell “CRM setup.”', 'We sell “CRM setup”'],
  ['We sell CRM setup in the U.S.', 'We sell CRM setup in the U.S'], // the sentence's own period follows: "U.S."
]
// Already ends without punctuation: unchanged (controls).
const CONTROLS = ['CRM setup and outbound consulting', 'SEO audits', 'payroll software', 'Version 2.0 support', '']
// Before the sentence's own "," or ";" (the first value in "you sell <X>, but it started with <Y>."): sentence
// punctuation goes, an abbreviation keeps its period, and text that is only punctuation is never shown as nothing.
const MID: [string, ',' | ';', string][] = [
  ['We sell CRM setup in the U.S.', ',', 'We sell CRM setup in the U.S.'],
  ['We sell CRM setup in the U.S.', ';', 'We sell CRM setup in the U.S.'],
  ['Payroll for Acme Inc.', ',', 'Payroll for Acme Inc.'],
  ['Audits, reviews, etc.', ';', 'Audits, reviews, etc.'],
  ['We sell CRM (U.S.)', ',', 'We sell CRM (U.S.)'],
  ['We sell CRM setup.', ',', 'We sell CRM setup'],
  ['We sell CRM setup!', ';', 'We sell CRM setup'],
  ['We sell CRM setup to the USA.', ',', 'We sell CRM setup to the USA'],
  ['...', ',', '...'],
  ['?!', ';', '?!'],
]

test('#349 an offer quoted inside a sentence drops its own closing punctuation (10 variants), and only that', () => {
  for (const [stored, quoted] of VARIANTS) {
    assert.equal(inSentence(stored), quoted, JSON.stringify(stored))
    // rendered as the choosers do: no doubled or stacked terminal punctuation
    assert.doesNotMatch(`but it started with ${inSentence(stored)}. dazl will not draft`, /[.!?…]["'”’)\]]*\. dazl|\.\.\s/, JSON.stringify(stored))
  }
  for (const c of CONTROLS) assert.equal(inSentence(c), c, `unchanged: ${JSON.stringify(c)}`)
})

test('#349 before a comma or semicolon an abbreviation keeps its period, and punctuation-only text is shown (10 variants)', () => {
  for (const [stored, next, quoted] of MID) assert.equal(inSentence(stored, next), quoted, `${JSON.stringify(stored)} before ${next}`)
  assert.equal(inSentence('...'), '...', 'never an empty quote before "." either')
})

// The rule, not the string: anywhere in app/ an offer-like value (offer, stated, recorded, saved, withdrawn, sells) is
// rendered in JSX - bare or inside any inline element - directly before sentence punctuation, it goes through
// inSentence with that same punctuation, so it can never render ".." or "U.S," and the rule cannot drift per call site.
test('#349 every offer-like value quoted before sentence punctuation in app/ goes through inSentence for that punctuation', () => {
  const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app')
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.tsx')) files.push(p) } }
  walk(app)
  const offenders: string[] = []
  let seen = 0
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/\{([^{}]{1,80})\}(?:<\/(?:strong|b|em|i|span|q|mark)>)?([.,;:])/g)) {
      const expr = m[1].trim(), punct = m[2]
      if (/^\w+\??\s*:|^[\w\s,]+,[\w\s,]+$/.test(expr)) continue // a type literal or a destructuring, not a rendered value
      if (!/\b(offer|stated|recorded|saved|withdrawn|sells)\b/i.test(expr)) continue
      seen++
      const call = expr.match(/^inSentence\((.*?)(?:,\s*'([.,;:])')?\)$/)
      if (!call) offenders.push(`${path.relative(app, f)}: {${expr}}${punct} is not passed through inSentence`)
      else if ((call[2] ?? '.') !== punct) offenders.push(`${path.relative(app, f)}: {${expr}}${punct} is told the wrong punctuation follows`)
    }
  }
  assert.deepEqual(offenders, [])
  assert.ok(files.length > 50 && seen >= 8, `the scan read the app sources and found the quoted offers (${seen})`)
})
