import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { heldBuyer } from '../lib/scan/held-buyer.ts'

// Run d84a33a0: UpGuard (Ashby d427d6c0) was held for no route; #1540 stores its site CEO as a person, but the held row showed nobody.
// The held row shows the buyer plainly: name and title only - never an email, contact, LinkedIn or label.
const e = (o: Partial<{ connector: string; kind: string; value: string; label: string | null }>) => ({ connector: 'sitecrawl', kind: 'person', value: '', label: null, confidence: null, source_url: 'https://www.upguard.com/company', source_date: '2026-11-22', retrieved_at: 0, ...o })
test('d84a33a0 UpGuard: the held row carries the stored site buyer as name and title only', () => {
  assert.deepEqual(heldBuyer([e({ kind: 'email', value: 'hello@upguard.com' }), e({ value: 'Mike Baukes, Co-Founder & CEO', label: "listed on the company's own team page" })]), { name: 'Mike Baukes', title: 'Co-Founder & CEO' })
  assert.equal(heldBuyer([e({ kind: 'email', value: 'x@upguard.com' })]), null)
  assert.equal(heldBuyer([e({ value: 'Contact Us, Sales' })]), null, 'interface text is never a person')
})
test('d84a33a0: the API and the held list show it', () => {
  const route = readFileSync(new URL('../app/api/leads/route.ts', import.meta.url), 'utf8')
  assert.match(route, /buyer: heldBuyer\(/)
  const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(page, /data-testid="held-buyer"/)
})
