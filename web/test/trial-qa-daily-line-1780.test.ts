import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import * as trialCopy from '../lib/trial-copy.ts'
import { usageLine } from '../lib/plan-usage-copy.ts'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../app/app/settings/plan-panel.tsx', import.meta.url), 'utf8')
const panel = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

const qa: trialCopy.TrialBlock = { funded: true, remaining: 3, cap: 3, used: 29, exempt: true }

function renderPlan(trial: trialCopy.TrialBlock | null) {
  const exports = {} as { default: (props: object) => React.ReactElement }
  const usage = { plan: 'free', scans_used: 0, scan_limit: 50, billing_status: null, trial }
  vm.runInNewContext(panel, {
    exports,
    require(id: string) {
      if (id === 'react') return { useState: (value: unknown) => [value === null ? usage : value], useEffect: () => {} }
      if (id === '@/lib/trial-copy') return trialCopy
      if (id === '@/lib/plan-usage-copy') return { usageLine }
      if (id === '@/lib/beta') return { BILLING_BETA_TEXT: '' }
      if (id === './panel-error') return {}
      return require(id)
    },
  })
  return renderToStaticMarkup(exports.default({}))
}

test('#1780 Settings Plan shows the shared daily limit while QA searches are unlimited', () => {
  const html = renderPlan(qa)
  assert.match(html, /unlimited free searches \(29 used\)/)
  assert.match(html, /data-testid="trial-daily-cap"[^>]*>A shared daily limit still applies\. It resets at midnight Toronto time\./)
})

test('#1780 the QA explanation does not appear for regular accounts or duplicate the daily refusal', () => {
  assert.doesNotMatch(renderPlan({ ...qa, exempt: false }), /trial-daily-cap/)
  assert.doesNotMatch(renderPlan(null), /trial-daily-cap/)
  const blocked = renderPlan({ ...qa, funded: false, blocked: 'global_daily_cap' })
  assert.match(blocked, /free searches are fully booked/)
  assert.doesNotMatch(blocked, /trial-daily-cap/)
})
