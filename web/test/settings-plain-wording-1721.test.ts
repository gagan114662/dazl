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
    assert.doesNotMatch(c.note, /not built|background service|separate switch/i, `${c.id} talks about what is built: ${c.note}`)
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

test('#1715 screen 4: the badge tells the reader what to expect, honestly per platform', () => {
  const s = src('settings/advanced-panel.tsx')
  assert.doesNotMatch(s, /Needs worker/, 'the "Needs worker" badge is gone')
  // A platform whose adapter IS built (consent + session below the badge) is not "not available": the badge says
  // what it needs (Gagan 2026-11-26 on #1917). Only an unbuilt adapter (supported === false) reads "Not available yet".
  assert.match(s, /worker: 'Needs your session'/, 'a built session platform says what it needs, in plain words')
  assert.match(s, /supported === false \? 'Not available yet'/, 'only an unbuilt adapter reads "Not available yet"')
  const reddit = CHANNELS.find(c => c.id === 'reddit')!
  assert.doesNotMatch(reddit.note, /^Not available yet\./, 'the Reddit note does not claim unavailable: its adapter is built')
})

test('#1721 the audit panel states the retention rule without guessing who set it', () => {
  const s = src('settings/audit-panel.tsx')
  assert.match(s, /unless a retention period is set for your workspace\./, 'says a period can be set, not who set it')
  assert.doesNotMatch(s, /dazl has set a longer retention period/, 'does not claim dazl set it')
})

// #1721/#1706 plain-words pass (Quest 2026-11-26): no tier numbers, audit table names, raw "workspace id" or model names in Settings.
test('#1721 Connectors group headings are plain words, not "Tier 0/1/2"', () => {
  const s = src('settings/advanced-panel.tsx')
  assert.doesNotMatch(s, /TIER_LABEL/, 'the heading no longer comes from the Tier N labels')
  assert.doesNotMatch(s, /Tier [012]/i)
  assert.match(s, /Works without setup/)
})

test('#1721 the deletion screens name what is kept in words, never table names or "workspace id"', () => {
  for (const p of ['settings/lifecycle-delete-controls.tsx', 'settings/lifecycle-panel.tsx']) {
    const s = src(p)
    assert.doesNotMatch(s, /always_retained\.join/, `${p} prints raw table names`)
    assert.doesNotMatch(s, /workspace id/i, `${p} says "workspace id"`)
    assert.doesNotMatch(s, /append-only audit records/, p)
  }
  const c = src('settings/lifecycle-delete-controls.tsx')
  assert.match(c, /retainedLabel/, 'kept records go through one plain-words label')
  assert.match(c, /confirmMatches/, 'the typed confirmation is still asked for')
})

test('#1721 the AI attempts list shows no vendor or model name and no "AI key" wording', () => {
  const s = src('settings/usage-panel.tsx')
  assert.doesNotMatch(s, /a\.vendor|a\.model/, 'no vendor/model name rendered')
  assert.doesNotMatch(s, /AI key on file/)
})

test('#1721 Settings has no Apollo / People Data Labs key rows, credit limits or "bring your own key" wording', () => {
  const s = src('settings/enrichment-panel.tsx')
  assert.doesNotMatch(s, /apollo|People Data Labs|pdl|bring your own|credit limit|Recent enrichment lookups|type="password"/i)
  assert.doesNotMatch(s, /fetch\('\/api\/settings\/enrichment', \{ method/, 'the panel no longer writes keys or limits')
  assert.match(s, /Email address checks/)
  const page = src('settings/page.tsx')
  assert.doesNotMatch(page, /Model key|Enrichment'|your AI key/)
})

test('#1721 the pre-run cost notes say what it costs and does, without model names', () => {
  for (const p of ['../lib/discover/pricing.ts', '../lib/scan/price-estimate.ts']) {
    const text = readFileSync(new URL(`../${p.replace('../', '')}`, import.meta.url), 'utf8')
    const notes = text.split('\n').filter(l => /^\s*(note:|\? `|: ')/.test(l)).join('\n')
    assert.ok(notes.length > 0, `${p}: found the cost notes`)
    assert.doesNotMatch(notes, /Sonnet|Haiku|Opus/, `${p}: a cost note names a model`)
  }
})
