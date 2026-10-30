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

test('#349 an offer quoted inside a sentence drops its own closing punctuation (10 variants), and only that', () => {
  for (const [stored, quoted] of VARIANTS) {
    assert.equal(inSentence(stored), quoted, JSON.stringify(stored))
    // rendered as the choosers do: no doubled or stacked terminal punctuation
    assert.doesNotMatch(`but it started with ${inSentence(stored)}. dazl will not draft`, /[.!?…]["'”’)\]]*\. dazl|\.\.\s/, JSON.stringify(stored))
  }
  for (const c of CONTROLS) assert.equal(inSentence(c), c, `unchanged: ${JSON.stringify(c)}`)
})

// The rule, not the string: any JSX that renders a value in bold followed by sentence punctuation must pass the value
// through inSentence, so a value ending in "." can never render "..".
test('#349 every value quoted in bold before sentence punctuation in app/ goes through inSentence', () => {
  const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app')
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.tsx')) files.push(p) } }
  walk(app)
  const offenders: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/<strong>\{([^{}]{1,80})\}<\/strong>[.,;:]/g)) if (!/^inSentence\(/.test(m[1].trim())) offenders.push(`${path.relative(app, f)}: {${m[1]}}`)
  }
  assert.deepEqual(offenders, [])
  assert.ok(files.length > 50, 'the scan read the app sources')
})
