import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

test('#1319 password rules survive a no-JavaScript render and describe the password field', () => {
  const source = readFileSync(new URL('../app/sign-up/sign-up-form.tsx', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  })
  const imported = { exports: {} as { default?: ComponentType<{ trialFunded: boolean }> } }
  const require = createRequire(import.meta.url)
  runInNewContext(outputText, {
    exports: imported.exports,
    require: (id: string) => {
      switch (id) {
        case 'next/navigation': return { useRouter: () => ({}) }
        case 'next/link': return { __esModule: true, default: 'a' }
        case '@/lib/invite-return': return {}
        case '@/lib/trial-copy': return { signUpPlanLine: () => 'Free plan' }
        case '../preview/claim/context-banner': return { useClaimContext: () => ({ googleHref: '/api/auth/google' }), ClaimContextBanner: () => null }
        default: return require(id)
      }
    },
  })
  assert.ok(imported.exports.default)
  const html = renderToStaticMarkup(createElement(imported.exports.default, { trialFunded: true }))
  const field = html.match(/<input\b[^>]*type="password"[^>]*>/)?.[0]
  assert.ok(field, 'the real form contains the password field')
  assert.match(field, /aria-describedby="signup-password-rules"/)
  assert.match(field, /minLength="10"/)
  assert.match(field, /autoComplete="new-password"/)
  assert.doesNotMatch(field, /placeholder="[^"]+/i, 'the hint is not clipped inside the input')
  assert.match(html, /<\/label><p id="signup-password-rules"[^>]*>Use at least 10 characters, including a letter and a number\.<\/p>/)
  const form = html.match(/<form\b[^>]*>/)?.[0]
  assert.ok(form)
  assert.match(form, /\bmethod="post"/i)
  assert.match(form, /\baction="\/api\/auth\/signup"/i)
})
