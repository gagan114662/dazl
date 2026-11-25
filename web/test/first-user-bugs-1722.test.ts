import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { playName, widenActions } from '../lib/play-card.ts'

test('#1722 place and signal are one button when both open the same request', () => {
  const q = 'Dental owners in NYC, 90 days, hiring front-desk staff'
  const acts = widenActions(q, { window_days: 90, where: ['NYC'], signals: ['hiring'] })
  assert.deepEqual(acts.map(a => a.label), ['Widen to 180 days', 'Change the place or signal'])
  assert.equal(new Set(acts.map(a => a.href)).size, acts.length, 'no two buttons share a URL')
  assert.ok(decodeURIComponent(acts[1].href).includes(q), 'the one button still opens the full request for editing')
  // Without signals the place button is unchanged.
  assert.deepEqual(widenActions(q, { window_days: 90, where: ['NYC'] }).map(a => a.label), ['Widen to 180 days', 'Change the place'])
})

test('#1722 an industry that already names companies is not doubled', () => {
  const name = playName('x', { summary: '', industries: ['Marketing agencies'], where: ['Toronto'], signals: ['Hiring SDRs'] })
  assert.doesNotMatch(name, /agencies companies/i)
  assert.equal(playName('x', { summary: '', industries: ['SaaS'], where: [], signals: [] }), 'Saas companies', 'an industry that does not name companies still gets the suffix')
})

test('#1722 Home sender readiness re-reads when the tab is used again', () => {
  for (const f of ['app/app/readiness.tsx', 'app/app/ready-card.tsx']) {
    const s = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    assert.ok(s.includes('visibilitychange') && s.includes("'focus'"), `${f} refreshes sender readiness on focus/visibility`)
  }
})
