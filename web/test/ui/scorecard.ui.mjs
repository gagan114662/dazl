// #398 rendered check: the published scorecard page (app/app/scorecard/page.tsx) says only what the evidence supports.
// NOT part of `npm test` (needs a browser). Run:  cd web && node test/ui/scorecard.ui.mjs   (SHOTS=<dir> saves 390 and 1280 px screenshots)
// Bundles the real page, renders it in headless Chromium at 390 and 1280 px with NO server, database, network, key or provider call. Two scenarios:
//  A. nothing published: the headline says no comparison has been run, no win or loss is stated, and the example is labelled SYNTHETIC / invented.
//  B. a live batch published (invented numbers, origin forced to live ONLY for this layout check) with an inconclusive repeated-run analysis: systems that did not run
//     show no numbers and "not counted as a loss", unknown cost reads "unknown", and the overall answer is "Inconclusive", not a win.
// Exit 1 on a failed expectation; "SKIP" (exit 0) when esbuild/playwright/chromium are not installed. The harness is unstyled: it shows wording and layout, not CSS.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\\n')[0]} (set NODE_PATH to a folder with esbuild and playwright)`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const example = JSON.parse(readFileSync(path.join(root, 'lib/benchmark/published/example-synthetic.json'), 'utf8'))

const live = structuredClone(example)
live.batch.manifest.origin = 'live'; live.batch.manifest.label = 'LIVE run (layout fixture: invented numbers)'
live.batch.report = live.batch.report.map(r => r.system === 'dazl' ? { ...r, spend_usd: null } : r)
live.superiority = {
  format: 'dazl-superiority', version: 1, plan: { id: 'plan-1', hash: 'abcdef0123456789abcdef', registered_at: '2026-11-01' }, look: 1, origin: 'live', label: 'LIVE',
  systems: { candidate: 'dazl', baseline: 'chatgpt-web-baseline' }, batches: [live.batch.manifest.batch_id], tasks: 4, repetitions: 1, missing_pairs: [],
  metrics: [{ metric: 'precision_at_10', direction: 'higher', min_effect: 0.05, primary: true, pairs: 3, clusters: 3, candidate_mean: 0.5, baseline_mean: 0.5, difference: 0, interval: null, decision: 'inconclusive', why: 'inadequate sample: 3 pairs in 3 clusters (registered minimum 20 pairs, 8 clusters)' }],
  floors: [{ id: 'precision_floor', ok: null, detail: 'not evaluable on this sample' }],
  targets: { precision_floor: { target: 0.9, candidate_interval: null, met: null }, yield_advantage: { target: 1.25, ratio: null, interval: null, met: null } },
  segments: [], overall: { decision: 'inconclusive', why: 'inadequate sample' }, evidence: { evaluator_validated: true, customer_outcomes: 'not measured here (opted-in pilot, #399)' },
}

async function bundle(latest) {
  const r = await esbuild.build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import Page from '@/app/app/scorecard/page'; createRoot(document.getElementById('root')).render(<Page />)`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error', alias: { '@': root }, define: { 'process.env.NODE_ENV': '"development"' },
    plugins: latest ? [{ name: 'latest', setup(b) { b.onResolve({ filter: /(^|\/)latest\.json$/ }, () => ({ path: 'latest', namespace: 'latest' })); b.onLoad({ filter: /.*/, namespace: 'latest' }, () => ({ contents: JSON.stringify(latest), loader: 'json' })) } }] : [],
  })
  return r.outputFiles[0].text
}
const html = js => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`
const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {})
const shots = process.env.SHOTS; if (shots) mkdirSync(shots, { recursive: true })
try {
  for (const [name, latest] of [['A-none', null], ['B-live', live]]) {
    const js = await bundle(latest)
    for (const [w, h] of [[390, 844], [1280, 900]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } }); const errs = []
      page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
      await page.setContent(html(js)); await page.getByTestId('headline').waitFor()
      const text = await page.evaluate(() => document.body.innerText)
      const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      assert.ok(fit.sw <= fit.cw + 1, `${name} ${w}px: horizontal scroll (${fit.sw} > ${fit.cw})`)
      assert.deepEqual(errs, [], `${name} ${w}px: console/page errors`)
      assert.match(text, /does not show|does and does not show/i)
      const sys = await page.getByTestId('system').evaluateAll(els => els.map(e => ({ ran: e.getAttribute('data-ran'), text: e.innerText })))
      if (name === 'A-none') {
        assert.match(await page.getByTestId('headline').innerText(), /No live or recorded comparison has been run yet/)
        assert.match(await page.getByTestId('sup-note').innerText(), /No win or loss can be stated/)
        assert.equal(await page.getByTestId('overall').count(), 0, 'no overall answer is shown')
        assert.match(await page.getByTestId('label-synthetic').innerText(), /SYNTHETIC/)
        assert.match(text, /Example layout \(invented data\)/)
        assert.equal(sys.length, 4)
      } else {
        assert.match(await page.getByTestId('headline').innerText(), /Latest comparison: live results/)
        assert.equal(sys.length, 8, 'live batch (4) plus the labelled example (4)')
        assert.equal(await page.getByTestId('label-live').count(), 1)
        const gone = sys.filter(s => s.ran === '0'); assert.equal(gone.length, 4, 'gojiberry and pancake x2 batches: did not run')
        for (const g of gone) { assert.match(g.text, /not counted as a loss/); assert.doesNotMatch(g.text, /Precision|Validated leads/) }
        const dazl = sys.find(s => s.ran === '1' && /^dazl/.test(s.text) && /unknown/.test(s.text)); assert.ok(dazl, 'dazl with unknown spend shows "unknown"')
        assert.equal((await page.getByTestId('overall').innerText()).trim(), 'Inconclusive')
        assert.doesNotMatch(text, /wins|Winner/)
      }
      if (shots) await page.screenshot({ path: path.join(shots, `scorecard-${name}-${w}.png`), fullPage: true })
      await page.close()
    }
    console.log(`${name}: 390 and 1280 px ok`)
  }
  console.log('scorecard UI check passed')
} finally { await browser.close() }
