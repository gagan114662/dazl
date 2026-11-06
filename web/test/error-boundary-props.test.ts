import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// #902 audit follow-up: the three Next error boundaries take `retry`, and the audit asked whether Next actually
// supplies that prop or only `reset`. This drives the installed Next ErrorBoundaryHandler (the class Next wraps
// every error.tsx/global-error.tsx in) and records the props it hands the error component, so a Next upgrade that
// drops `retry` fails here instead of breaking "Try again" in production.
const require = createRequire(import.meta.url)

test('installed Next ErrorBoundaryHandler hands the error component both retry and reset functions', async () => {
  const React = require('react') as typeof import('react')
  const { renderToString } = require('react-dom/server') as typeof import('react-dom/server')
  const { ErrorBoundaryHandler } = require('next/dist/client/components/error-boundary.js')
  let received: Record<string, unknown> | null = null
  const ErrorComponent = (props: Record<string, unknown>) => { received = props; return null }
  const Boom = () => { throw new Error('synthetic boundary test error') }
  // renderToString does not run class getDerivedStateFromError, so seed the handler's error state directly the way
  // React would after a client render failure.
  class Seeded extends ErrorBoundaryHandler {
    constructor(props: unknown) { super(props); this.state = { error: { thrownValue: new Error('synthetic') }, previousPathname: '/app' } }
  }
  renderToString(React.createElement(Seeded, { pathname: '/app', errorComponent: ErrorComponent }, React.createElement(Boom)))
  assert.ok(received, 'error component was rendered')
  const props = received as Record<string, unknown>
  assert.equal(typeof props.retry, 'function', 'Next must supply retry')
  assert.equal(typeof props.reset, 'function', 'Next must supply reset')
})

test('each boundary binds Try again to the retry prop Next supplies', () => {
  for (const f of ['app/app/error.tsx', 'app/error.tsx', 'app/global-error.tsx']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    assert.match(src, /\{\s*error,\s*retry\s*\}:\s*\{\s*error: unknown;\s*retry: \(\) => void\s*\}/, f)
    assert.match(src, /onClick=\{\(\) => retry\(\)\}>Try again/, f)
  }
})
