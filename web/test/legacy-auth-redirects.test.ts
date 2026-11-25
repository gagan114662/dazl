import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// Legacy auth URLs must permanently redirect to canonical pages and keep query values.
// Parse the real TSX sources and exercise their exports against the real Next runtime.
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const LEGACY_ROUTES = [
  { route: 'app/signup/page.tsx', destination: '/sign-up' },
  { route: 'app/register/page.tsx', destination: '/sign-up' },
  { route: 'app/signin/page.tsx', destination: '/sign-in' },
  { route: 'app/login/page.tsx', destination: '/sign-in' },
]

test('legacy auth redirects: every route compiles as valid TSX', () => {
  for (const { route } of LEGACY_ROUTES) {
    const source = readFileSync(join(WEB_ROOT, route), 'utf8')
    const { diagnostics } = ts.transpileModule(source, {
      fileName: route,
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert.equal(
      errors.length,
      0,
      `${route}: ${errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('; ')}`,
    )
  }
})

test('legacy auth redirects: permanent redirect to the canonical page', () => {
  for (const { route, destination } of LEGACY_ROUTES) {
    const source = readFileSync(join(WEB_ROOT, route), 'utf8')
    assert.ok(source.includes('permanentRedirect'), `${route} must use permanentRedirect`)
    assert.ok(source.includes(`'${destination}'`), `${route} must target ${destination}`)
    assert.ok(!source.includes('redirect('), `${route} must not use a non-permanent redirect`)
  }
})

test('legacy auth redirects: query string is preserved', () => {
  for (const { route } of LEGACY_ROUTES) {
    const source = readFileSync(join(WEB_ROOT, route), 'utf8')
    assert.ok(source.includes('searchParams'), `${route} must read searchParams`)
    assert.ok(source.includes('URLSearchParams'), `${route} must rebuild the query string`)
    assert.ok(source.includes('await searchParams'), `${route} must await searchParams`)
  }
})

test('legacy auth redirects: every legacy URL has a route file', () => {
  assert.equal(LEGACY_ROUTES.length, 4)
  for (const { route } of LEGACY_ROUTES) {
    assert.doesNotThrow(() => readFileSync(join(WEB_ROOT, route), 'utf8'), `${route} is missing`)
  }
})

test('legacy auth redirects: real Next permanentRedirect preserves query values', async () => {
  const tempDir = mkdtempSync(join(WEB_ROOT, '.tmp-redirect-test-'))
  try {
    const modules = new Map<string, { default: (arg: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<never> }>()
    for (let i = 0; i < LEGACY_ROUTES.length; i++) {
      const { route } = LEGACY_ROUTES[i]
      const source = readFileSync(join(WEB_ROOT, route), 'utf8')
      const output = ts.transpileModule(source, {
        fileName: route,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      }).outputText
      const file = join(tempDir, `route-${i}.cjs`)
      writeFileSync(file, output)
      const imported = await import(pathToFileURL(file).href)
      modules.set(route, { default: imported.default?.default ?? imported.default })
    }

    const scenarios: Array<Record<string, string | string[] | undefined>> = [
      {},
      { tag: ['one', 'two'], next: '/account' },
      { label: 'café 東京', next: '/welcome' },
      { value: 'already%2Fencoded%20value' },
      { next: '/sign-in?from=invite&mode=full' },
    ]
    const expectedQueries = ['', 'tag=one&tag=two&next=%2Faccount', 'label=caf%C3%A9+%E6%9D%B1%E4%BA%AC&next=%2Fwelcome', 'value=already%252Fencoded%2520value', 'next=%2Fsign-in%3Ffrom%3Dinvite%26mode%3Dfull']

    for (const { route, destination } of LEGACY_ROUTES) {
      const mod = modules.get(route)!
      for (let i = 0; i < scenarios.length; i++) {
        let thrown: unknown
        try {
          await mod.default({ searchParams: Promise.resolve(scenarios[i]) })
        } catch (error) {
          thrown = error
        }
        assert.ok(thrown instanceof Error, `${route} scenario ${i}: expected Next redirect error`)
        const digest = (thrown as Error & { digest?: string }).digest ?? ''
        assert.match(digest, /^NEXT_REDIRECT;/, `${route} scenario ${i}: ${digest}`)
        assert.match(digest, /^NEXT_REDIRECT;replace;/, `${route} scenario ${i}: expected replace redirect marker in ${digest}`)
        assert.match(digest, /;308;$/, `${route} scenario ${i}: expected 308 in ${digest}`)
        const match = digest.match(/^NEXT_REDIRECT;replace;(.+);308;$/)
        assert.ok(match, `${route} scenario ${i}: redirect URL missing from ${digest}`)
        const expectedUrl = expectedQueries[i] ? `${destination}?${expectedQueries[i]}` : destination
        assert.equal(match[1], expectedUrl, `${route} scenario ${i}: ${digest}`)
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
