import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

// #1781: /sign-in and /sign-up had no site footer. One shared component, copied from the homepage's footer, is now
// rendered by both auth layouts inside the visible-height wrapper. /privacy and /terms are another owner's files; the
// PR carries the same two-line change (import + <SiteFooter />) for them.
const footer = readFileSync(new URL('../app/site-footer.tsx', import.meta.url), 'utf8')
const home = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
const layouts = ['sign-in', 'sign-up'].map((name) => ({
  name,
  src: readFileSync(new URL(`../app/${name}/layout.tsx`, import.meta.url), 'utf8'),
}))

// Every link in a footer block, in order. The support address is a template, so it is compared by shape.
function hrefs(src: string): string[] {
  return [...src.matchAll(/href=(?:"([^"]*)"|\{`mailto:\$\{SUPPORT_EMAIL\}`\})/g)].map((m) => m[1] ?? 'mailto:SUPPORT_EMAIL')
}

test('#1781 the shared footer carries the homepage footer\'s markup and links', () => {
  const homeFooter = /<footer[\s\S]*?<\/footer>/.exec(home)?.[0]
  assert.ok(homeFooter, 'the homepage still has its footer')
  assert.deepEqual(hrefs(footer), hrefs(homeFooter), 'the same links, in the same order as the homepage')
  assert.deepEqual(hrefs(footer), ['/terms', '/privacy', '/contact', 'mailto:SUPPORT_EMAIL', '/sign-in'])
  assert.match(footer, /<footer className="mt-auto border-t border-\[var\(--line\)\]">/)
  assert.match(footer, /<nav aria-label="Footer"/)
  assert.match(footer, /© 2026 dazl/)
  assert.match(footer, /import \{ SUPPORT_EMAIL \} from '@\/lib\/site'/)
})

test('#1781 every internal footer link points at a page that exists', () => {
  for (const href of hrefs(footer).filter((h) => h.startsWith('/'))) {
    assert.ok(existsSync(new URL(`../app${href}/page.tsx`, import.meta.url)), `${href} has a page`)
  }
})

for (const { name, src } of layouts) {
  test(`#1781 /${name} renders the shared site footer inside the visible-height wrapper`, () => {
    assert.match(src, /import SiteFooter from '\.\.\/site-footer'/, 'the shared component, not a copy')
    assert.match(src, /<div className="min-h-\[100dvh\][^"]*">\s*\{children\}\s*<SiteFooter compact \/>\s*<\/div>/, 'after the page and inside the wrapper: a footer below the fold would not be seen')
  })
}

test('#1781 the auth pages are not edited here: their <main> still centres the card', () => {
  const signIn = readFileSync(new URL('../app/sign-in/page.tsx', import.meta.url), 'utf8')
  const signUp = readFileSync(new URL('../app/sign-up/sign-up-form.tsx', import.meta.url), 'utf8')
  for (const src of [signIn, signUp]) {
    assert.match(src, /<main id="main" className="min-h-screen flex items-center justify-center glow px-4 py-10">/)
  }
})
