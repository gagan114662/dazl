import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as readiness from '../lib/readiness.ts'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../app/app/readiness.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function renderChecklist(exempt: boolean): string {
  const input = { profile: null, usage: { has_key: false, trial: { funded: true, remaining: 3, exempt } }, outreach: null }
  const exports = {} as { default: ComponentType }
  const state = [input, []]
  vm.runInNewContext(compiled, {
    exports,
    require(id: string) {
      if (id === 'react') return {
        useState: (initial: unknown) => [state.length ? state.shift() : initial],
        useRef: (current: unknown) => ({ current }),
        useEffect: () => {},
      }
      if (id === '@/lib/readiness') return readiness
      if (id === 'next/link') return { default: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children) }
      if (id === './ui/bits') return { Pill: ({ children }: { children: ReactNode }) => children }
      if (['./key-inline', './sender-inline', '@/lib/onboarding', './ui/icons', './readiness-input', '@/lib/focus-refresh'].includes(id)) return {}
      return require(id)
    },
  })
  const html = renderToStaticMarkup(createElement(exports.default))
  const row = html.match(/data-testid="ready-key"[^>]*>([\s\S]*?)<\/li>/)?.[1]
  assert.ok(row, 'the Home checklist renders the search funding row')
  return row
}

test('#1704 Home omits the remaining count for an exempt trial and keeps it for a normal trial', () => {
  const exempt = renderChecklist(true)
  assert.match(exempt, /using free searches/)
  assert.doesNotMatch(exempt, /\b\d+\s+left\b/i)
  assert.match(renderChecklist(false), /using free searches \(3 left\)/)
})
