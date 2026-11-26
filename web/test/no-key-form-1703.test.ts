// #1703: bring-your-own-key is finished for launch. No customer is ever sent to a key form: no step, link or button in the
// readiness checklist, the Home setup card or the source availability rows points at #model-key or an inline key field,
// and the shared key component renders nothing and never calls the key route.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readinessRows, type ReadinessInput } from '../lib/readiness.ts'
import { readyItems } from '../lib/ready-card.ts'
import { analysisPrerequisite } from '../lib/scan/source-availability.ts'

const base: ReadinessInput = {
  profile: { website: 'https://brightsmile.example', sells: 'Online booking', business_name: 'Brightsmile', buyer: { summary: 'Dental practices', who: ['Owner'] } },
  usage: { has_key: false }, keys: [], rejection: null,
  outreach: { gmail: null, sender: null },
  sources: { web_index: false, news: true, websites: true }, advanced: { available: true, platforms: [] },
  jobs: [], totals: { searches: 0, finished: 0 }, campaigns: [], messages: [],
}
const states: Record<string, ReadinessInput> = {
  'no key, no free searches': base,
  'free searches used up': { ...base, usage: { has_key: false, trial: { funded: true, remaining: 0 } } },
  'google sign-in blocks the trial': { ...base, usage: { has_key: false, trial: { funded: true, remaining: 3, blocked: 'google_required' } } },
  'a saved key that stopped working': { ...base, usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: { error: 'key_rejected' } },
  'a saved key that cannot be read': { ...base, usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: { error: 'key_unreadable' } },
}

test('#1703 no readiness row, setup step or availability row sends anyone to a key form', () => {
  for (const [name, input] of Object.entries(states)) {
    for (const r of readinessRows(input)) {
      assert.ok(!r.fix || r.fix.kind === 'link' || r.id === 'sender', `${name}: row ${r.id} offers an inline field`) // the sender row's inline form is the mailing address, not a key
      if (r.fix?.kind === 'link') assert.doesNotMatch(r.fix.href, /model-key/, `${name}: row ${r.id} links to the key section`)
      assert.doesNotMatch(r.fix?.label ?? '', /key/i, `${name}: row ${r.id} button says key`)
      assert.doesNotMatch(r.detail, /\b(add|save|paste|replace)\b[^.;]*\bkey\b/i, `${name}: row ${r.id} asks for a key: ${r.detail}`)
    }
    for (const x of readyItems(input)) {
      for (const f of [x.fix, x.alt]) {
        if (!f) continue
        assert.doesNotMatch(f.href, /model-key/, `${name}: step ${x.id} links to the key section`)
        assert.doesNotMatch(f.label, /key/i, `${name}: step ${x.id} button says key`)
      }
      assert.doesNotMatch(x.detail, /\b(add|save|paste|replace)\b[^.;]*\bkey\b/i, `${name}: step ${x.id} asks for a key: ${x.detail}`)
    }
  }
  for (const k of [{ has_key: false }, { has_key: false, trial: { funded: true, remaining: 0 } }]) {
    const a = analysisPrerequisite(k)
    assert.equal(a?.usable, false)
    assert.doesNotMatch(a?.fix?.href ?? '', /model-key/)
    assert.doesNotMatch(a?.fix?.label ?? '', /key/i)
    assert.doesNotMatch(a?.reason ?? '', /\bkey\b/i)
  }
})

test('#1703 when searches run out the way forward is the plan page', () => {
  const i = states['free searches used up']
  assert.equal(readyItems(i).find(x => x.id === 'search')?.fix?.href, '/app/settings#plan')
  assert.equal(analysisPrerequisite({ has_key: false, trial: { funded: true, remaining: 0 } })?.fix?.href, '/app/settings#plan')
})

test('#1703 the shared key component renders no field and never calls the key route', () => {
  const s = readFileSync(new URL('../app/app/key-inline.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(s, /<input|type="password"|settings\/llm-key|console\.anthropic\.com|Get an Anthropic key/)
  assert.match(s, /return null/)
})
