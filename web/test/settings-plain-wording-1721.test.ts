// #1721 and #1715 screens 3-4: Settings copy told the user about "the operator" (dazl's own staff), named internal
// pieces ("TinyFish", "Piped instances", a "worker") and left dangling clauses like "also billing and owners".
// These tests read what is actually rendered: the connector notes are imported, the panels are read as source.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CHANNELS } from '../lib/channels.ts'

const src = (p: string) => readFileSync(new URL(`../app/app/${p}`, import.meta.url), 'utf8')
const PANELS = [
  'settings/audit-panel.tsx',
  'settings/enrichment-panel.tsx',
  'settings/team-panel.tsx',
  'settings/advanced-panel.tsx',
  'settings/plan-panel.tsx',
  'settings/usage-panel.tsx',
]

test('#1721 the connector notes are in plain words: no operator, TinyFish, Piped instances or worker', () => {
  assert.ok(CHANNELS.length > 0)
  for (const c of CHANNELS) {
    assert.doesNotMatch(c.note, /\boperator\b/i, `${c.id} calls dazl "the operator": ${c.note}`)
    assert.doesNotMatch(c.note, /TinyFish/i, `${c.id} names an internal service: ${c.note}`)
    assert.doesNotMatch(c.note, /Piped instances?/i, `${c.id} says "Piped instances": ${c.note}`)
    assert.doesNotMatch(c.note, /\bworker\b/i, `${c.id} says "worker": ${c.note}`)
  }
})

test('#1721 no Settings screen calls dazl "your operator" or "the site operator"', () => {
  for (const p of PANELS) {
    const s = src(p)
    assert.doesNotMatch(s, /your operator|site operator|the operator has set a key|set by the operator|operator kill switch/i, p)
  }
})

test('#1715 screen 3: the team panel says what you can do, and the operator role keeps its stored value', () => {
  const s = src('settings/team-panel.tsx')
  assert.doesNotMatch(s, /You are .* in your own workspace/, 'the old "You are <role> in your own workspace" sentence is gone')
  assert.doesNotMatch(s, /also billing and owners/, 'the dangling "also billing and owners" clause is gone')
  assert.match(s, /In \{place\} you can \{ROLE_HELP\[mine\]\}/, 'the sentence says what the reader can do')
  assert.match(s, /const ROLE_LABEL: Record<Role, string> = \{[^}]*operator: '/, 'the operator role has a plain label')
  assert.match(s, /const ROLES: Role\[\] = \['viewer', 'operator', 'admin', 'owner'\]/, 'the stored role value is unchanged')
  assert.match(s, /<option key=\{r\} value=\{r\}>\{ROLE_LABEL\[r\]\}<\/option>/, 'the option value is the role, the text is its label')
  assert.match(s, /role: e\.target\.value/, 'the member PATCH still sends the stored value')
  assert.match(s, /send\('\/api\/workspace\/invitations', 'POST', \{ email, role \}\)/, 'the invite still sends the stored value')
})

test('#1715 screen 4: the "Needs worker" badge tells the reader what to expect', () => {
  const s = src('settings/advanced-panel.tsx')
  assert.doesNotMatch(s, /Needs worker/, 'the "Needs worker" badge is gone')
  assert.match(s, /worker: 'Not available yet'/, 'the worker status reads as a plain, honest state')
})

test('#1721 the audit panel states the retention rule without guessing who set it', () => {
  const s = src('settings/audit-panel.tsx')
  assert.match(s, /unless a retention period is set for your workspace\./, 'says a period can be set, not who set it')
  assert.doesNotMatch(s, /dazl has set a longer retention period/, 'does not claim dazl set it')
})
