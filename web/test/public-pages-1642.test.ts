// #1642, #1649, #1650, #1644 (footer): what the public pages' sources must say. Source checks only; the pages themselves are
// checked in the browser on staging.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { SUPPORT_EMAIL } from '../lib/site.ts'
import { OWNER_PLACEHOLDERS } from '../lib/legal/policy.ts'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('#1642: unknown addresses get a dazl page with the way home, not the framework default', () => {
  assert.ok(existsSync(new URL('../app/not-found.tsx', import.meta.url)))
  const page = read('app/not-found.tsx')
  assert.match(page, /<h1[^>]*>Page not found<\/h1>/)
  assert.match(page, /<Link href="\/"[^>]*>dazl/)
  assert.match(page, /<Link href="\/"[^>]*>Back to dazl<\/Link>/)
  assert.match(page, /robots: \{ index: false, follow: false \}/)
})

test('#1650: /contact and the homepage footer give the support address; data requests keep the privacy address', () => {
  assert.equal(SUPPORT_EMAIL, 'support@dazl.ai')
  assert.notEqual(SUPPORT_EMAIL, OWNER_PLACEHOLDERS.privacyContact)
  const contact = read('app/contact/page.tsx')
  assert.match(contact, /Questions about dazl, a problem to report, or help with your account: email <a[^>]*href=\{`mailto:\$\{SUPPORT_EMAIL\}`\}/)
  assert.match(contact, /Requests about your data or your privacy: email <a[^>]*href=\{`mailto:\$\{email\}`\}/)
  assert.match(contact, /const email = OWNER_PLACEHOLDERS\.privacyContact/)
  const footer = /<footer[\s\S]*<\/footer>/.exec(read('app/page.tsx'))?.[0] ?? ''
  assert.match(footer, /mailto:\$\{SUPPORT_EMAIL\}/)
  // #1644: items wrap whole; "Sign in" is not a trailing word of one long sentence
  assert.match(footer, /<nav aria-label="Footer" className="flex flex-wrap[^"]*gap-x-4/)
  assert.doesNotMatch(footer, / · /)
})

test('#1649: the reset page has the dazl name, visible labels, a sentence-case button and wording true for any address', () => {
  const form = read('app/reset/reset-form.tsx')
  assert.match(form, /<Link href="\/"[^>]*>dazl/)
  assert.match(form, /<label[^>]*>Email\s*<input name="email"/)
  assert.match(form, /<label[^>]*>New password\s*<input name="password"/)
  assert.match(form, /If an account uses that email, we will send it a link that works for 30 minutes\./)
  assert.doesNotMatch(form, /We will email you a link/)
  assert.match(form, /className="btn-primary btn-plain /)
  assert.match(read('app/globals.css'), /\.btn-plain \{[^}]*text-transform: none;/)
})
