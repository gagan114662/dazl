// #1603: every "Connect Gmail" or "Reconnect" link in the app goes to the page that explains Google's unverified-app
// warning first (GMAIL_EXPLAINER_PATH). Only that page's own Continue button starts the connect at /api/gmail/connect.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GMAIL_CONNECT_START, GMAIL_EXPLAINER_PATH } from '../lib/auth-google-explainer.ts'

const APP = fileURLToPath(new URL('../app/', import.meta.url))
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) ? [join(dir, e.name)] : [])
const pages = files(APP).map(f => ({ rel: relative(APP, f), src: readFileSync(f, 'utf8') }))

test('#1603 no page links straight to the Gmail connect start except the explainer page', () => {
  assert.equal(GMAIL_CONNECT_START, '/api/gmail/connect'); assert.equal(GMAIL_EXPLAINER_PATH, '/app/connect-gmail')
  // the route's own file lives under api/gmail/connect; a mention of the path anywhere else in app/ is a link or redirect to it
  const direct = pages.filter(p => !p.rel.startsWith('api/gmail/connect/') && (p.src.includes(GMAIL_CONNECT_START) || p.src.includes('GMAIL_CONNECT_START'))).map(p => p.rel).sort()
  assert.deepEqual(direct, ['app/connect-gmail/page.tsx'])
})

test('#1603 the Connect and Reconnect links on Settings and onboarding go to the explainer page', () => {
  for (const [rel, n] of [['app/settings/gmail-panel.tsx', 2], ['app/settings/replies-panel.tsx', 2], ['app/onboarding/first-review.tsx', 1]] as const) {
    const src = pages.find(p => p.rel === rel)!.src
    assert.equal(src.split('href={GMAIL_EXPLAINER_PATH}').length - 1, n, `${rel}: ${n} link(s) to the explainer`)
  }
})
