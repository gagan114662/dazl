import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'

test('#1813: reload hint appears at ten seconds and the timer is cleared on unmount', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const file = new URL('../app/app/workspace-reload-hint.tsx', import.meta.url)
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: 'workspace-reload-hint.tsx',
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  let shown = false
  let cleanup: (() => void) | undefined
  let mounted = false
  const react = {
    useState: (initial: boolean) => [mounted ? shown : initial, (value: boolean) => { shown = value }],
    useEffect: (setup: () => () => void) => {
      if (!mounted) cleanup = setup()
    },
  }
  const exports: { default?: () => Parameters<typeof renderToStaticMarkup>[0] } = {}
  new Function('require', 'exports', outputText)((id: string) => {
    assert.ok(id === 'react' || id === 'react/jsx-runtime')
    return id === 'react' ? react : jsxRuntime
  }, exports)
  assert.ok(exports.default)
  const Component = exports.default
  const render = () => {
    const html = renderToStaticMarkup(Component())
    mounted = true
    return html
  }

  assert.doesNotMatch(render(), /reload the page/i)
  t.mock.timers.tick(9900)
  assert.doesNotMatch(render(), /reload the page/i)
  t.mock.timers.tick(100)
  assert.match(render(), /reload the page/i)

  cleanup?.()
  mounted = false
  shown = false
  assert.doesNotMatch(render(), /reload the page/i)
  cleanup?.()
  t.mock.timers.tick(10000)
  assert.equal(shown, false)
})
