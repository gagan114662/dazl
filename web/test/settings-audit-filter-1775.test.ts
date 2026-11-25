import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

test('the loaded audit trail shows historical Autopilot events but never offers an Autopilot filter', () => {
  const source = readFileSync(new URL('../app/app/settings/audit-panel.tsx', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  })
  const require = createRequire(import.meta.url)
  const component = {} as { default: ComponentType }
  const events = [{ id: 'old', at: 1, actor_kind: 'service', actor_id: 'test', action: 'autopilot.paused' }]
  runInNewContext(outputText, {
    exports: component,
    require: (id: string) => id === 'react' ? {
      useState: (initial: unknown) => [initial === null ? events : initial, () => {}],
      useEffect: () => {},
    } : require(id),
  })
  const html = renderToStaticMarkup(createElement(component.default))
  assert.match(html, /Autopilot: paused/)
  const options = html.match(/<select\b[^>]*aria-label="Show"[^>]*>([\s\S]*?)<\/select>/)?.[1]
  assert.ok(options, 'the Show dropdown rendered')
  assert.match(options, />Everything<\/option>/)
  assert.doesNotMatch(options, /autopilot/i)
})
