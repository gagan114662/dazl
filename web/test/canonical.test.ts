import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseHomepage } from '../lib/seo/audit.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('every indexable public page carries a self-referencing canonical built from SITE_BASE', () => {
  const pages: [string, string][] = [
    ['app/page.tsx', 'canonical: SITE_BASE'],
    ['app/privacy/page.tsx', 'canonical: `${SITE_BASE}/privacy`'],
    ['app/terms/page.tsx', 'canonical: `${SITE_BASE}/terms`'],
    ['app/sign-in/layout.tsx', 'canonical: `${SITE_BASE}/sign-in`'],
    ['app/sign-up/layout.tsx', 'canonical: `${SITE_BASE}/sign-up`'],
  ]
  for (const [file, needle] of pages) {
    const src = read(file)
    assert.ok(src.includes('alternates'), `${file} sets no alternates`)
    assert.ok(src.includes(needle), `${file} canonical should be ${needle}`)
  }
})

test('authenticated app pages get no canonical (they must not claim a public URL)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(join(new URL('..', import.meta.url).pathname, dir)).flatMap(f => {
      const rel = `${dir}/${f}`
      const abs = join(new URL('..', import.meta.url).pathname, rel)
      return statSync(abs).isDirectory() ? walk(rel) : [rel]
    })
  const offenders = walk('app/app').filter(f => f.endsWith('.tsx') && /canonical/.test(read(f)))
  assert.deepEqual(offenders, [])
})

test('the Indexing audit parser reads back the tag Next emits', () => {
  const html = '<html><head><title>dazl</title><link rel="canonical" href="https://dazl.ai"></head><body></body></html>'
  const parsed = parseHomepage(html)
  assert.equal(parsed.canonical, 'https://dazl.ai')
})

test('sitemap, robots and canonical share one base (drift is how the audit finding happened)', () => {
  for (const f of ['app/sitemap.ts', 'app/robots.ts', 'app/page.tsx']) {
    assert.ok(read(f).includes('SITE_BASE'), `${f} should use the shared SITE_BASE`)
  }
  const site = read('lib/site.ts')
  assert.ok(site.includes("process.env.PUBLIC_BASE_URL || 'https://dazl.ai'"), 'SITE_BASE keeps the documented apex default')
})
