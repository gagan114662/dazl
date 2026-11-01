import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A React onSubmit-only <form> has no method attribute, so before hydration (or with JS disabled)
// the browser falls back to a NATIVE GET submission - and every field, including passwords and API
// keys, lands in the URL query: server access logs, browser history, proxy logs. Observed live:
// sign-up and sign-in both submitted credentials in the URL with JavaScript disabled. The invariant:
// any form on a page that collects a password/secret MUST declare method="post" so the pre-hydration
// fallback never puts credentials in a URL (a native POST 405s harmlessly instead).

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : []
  })

const FORMS = /<form\b[^>]*>/g

test('every form on a credential-collecting page declares method="post"', () => {
  const offenders: string[] = []
  for (const file of walk(join(new URL('.', import.meta.url).pathname, '..', 'app'))) {
    const src = readFileSync(file, 'utf8')
    if (!/type=["']password["']/.test(src)) continue
    for (const m of src.matchAll(FORMS)) {
      if (!/method=["']?post/i.test(m[0])) offenders.push(`${file}: ${m[0].slice(0, 80)}`)
    }
  }
  assert.deepEqual(offenders, [], 'credential pages whose forms would leak secrets into the URL on native GET')
})

test('the public auth forms (sign-up, sign-in, reset) declare method="post"', () => {
  for (const f of ['app/sign-up/page.tsx', 'app/sign-in/page.tsx', 'app/reset/reset-form.tsx']) {
    const src = readFileSync(join(new URL('.', import.meta.url).pathname, '..', f), 'utf8')
    for (const m of src.matchAll(FORMS)) {
      assert.match(m[0], /method=["']?post/i, `${f}: ${m[0].slice(0, 80)}`)
    }
  }
})
