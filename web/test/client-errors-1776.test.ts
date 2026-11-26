import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { clientReport } from '../lib/client-error-report.ts'
import { recordClientError } from '../lib/ops/client-errors.ts'
import { outboundRecord, parseSentryDsn, setErrorSinks, toSentryEnvelope } from '../lib/ops/errors.ts'

const require = createRequire(import.meta.url)
const fixtureStack = [
  '    at LeadCard (https://example.test/_next/static/chunks/lead.js?email=someone@example.test:1:2)',
  '    at section (<anonymous>)',
  'LeadsPage@https://example.test/_next/static/chunks/page.js:1:2',
  '    at sk_live_abcdefghijklmnop (https://example.test/_next/static/chunks/page.js:1:2)',
  '    at someone@example.test',
  '    at invalid-frame (<anonymous>)',
  'someone@example.test',
].join('\n')

test('#1776 the Next callback carries component names into Sentry only', () => {
  const load = require('../scripts/next-recoverable-error-loader.cjs')
  const original = readFileSync(require.resolve('next/dist/client/react-client-callbacks/on-recoverable-error.js'), 'utf8')
  const transformed = load(original)
  let reported: unknown
  const mock = (id: string) => {
    if (id.endsWith('/report-global-error')) return { reportGlobalError: (error: unknown) => { reported = error } }
    return createRequire(require.resolve('next/dist/client/react-client-callbacks/on-recoverable-error.js'))(id)
  }
  const exports: { onRecoverableError?: (error: Error, info: { componentStack: string }) => void } = {}
  runInNewContext(transformed, { exports, Error, require: mock, process: { env: { NODE_ENV: 'production' } } })
  const originalError = Object.assign(new Error('private message'), { digest: '1971300154' })
  assert.ok(exports.onRecoverableError)
  exports.onRecoverableError(originalError, { componentStack: fixtureStack })
  assert.equal(reported, originalError)
  const body = JSON.parse(clientReport('error', reported, '/app/leads'))
  assert.equal(Object.hasOwn(body, 'digest'), false)
  assert.doesNotMatch(JSON.stringify(body.componentStack), /invalid-frame|someone@example/)
  const restore = setErrorSinks([])
  try {
    const r = recordClientError({ ...body, digest: '1971300154', componentStack: [...body.componentStack, 'invalid-frame'] }, {})
    const dsn = parseSentryDsn('https://test@example.test/12')
    assert.ok(r && r !== 'invalid' && dsn)
    const event = JSON.parse(toSentryEnvelope(r, dsn).split('\n')[2])
    assert.deepEqual(event.contexts.react, { componentStack: ['LeadCard', 'section', 'LeadsPage'] })
    assert.doesNotMatch(JSON.stringify(event), /1971300154|someone@example|sk_live_|private message|https:\/\/example.test/)
    assert.doesNotMatch(JSON.stringify([r, outboundRecord(r, { environment: 'test' })]), /LeadCard|1971300154/)
  } finally { restore() }
})

test('#1776 error boundaries render only their public copy', () => {
  const error = Object.assign(new Error('private message'), {
    digest: '1971300154',
    [Symbol.for('dazl.react.componentStack')]: fixtureStack,
  })
  for (const path of ['app/error.tsx', 'app/app/error.tsx', 'app/global-error.tsx']) {
    const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
    }).outputText
    const exports: { default?: (props: { error: Error; retry: () => void }) => ReturnType<typeof import('react').createElement> } = {}
    runInNewContext(output, { exports, require: (id: string) => id.startsWith('@/') ? require('../' + id.slice(2) + '.ts') : require(id) })
    assert.ok(exports.default)
    const { createElement } = require('react') as typeof import('react')
    const html = renderToStaticMarkup(createElement(exports.default, { error, retry: () => {} }))
    assert.match(html, /Reload/)
    assert.doesNotMatch(html, /componentStack|digest|LeadCard|LeadsPage|1971300154|private message|someone@example/)
  }
})
