// Plays vs Leads navigation (#351). The live audit clicked Plays from a held lead run and landed on /app/leads with
// the latest results. Plays must open the saved-play list (/app/plays: schedule, last/next run, pause/resume/delete);
// Leads opens results. This runs in `npm test` (CI); the rendered click-through is test/ui/plays.ui.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const nav = read('../app/app/nav.tsx')
const page = read('../app/app/plays/page.tsx')
const client = read('../app/app/plays/plays-client.tsx')
const item = (label: string) => {
  const m = new RegExp(`\\{ href: '([^']+)', label: '${label}', icon: '[a-z]+', match: p => ([^}]+) \\}`).exec(nav)
  assert.ok(m, `the ${label} navigation item exists`)
  return { href: m[1], match: m[2].trim() }
}

test('the main navigation sends Plays to play management and Leads to results', () => {
  const plays = item('Plays'), leads = item('Leads')
  assert.equal(plays.href, '/app/plays', 'Plays opens the saved-play list, not a Leads view')
  assert.equal(plays.match, "p.startsWith('/app/plays')", 'Plays is the current page only on /app/plays')
  assert.ok(leads.href.startsWith('/app/leads'), 'Leads opens results')
  assert.equal(/\/app\/leads/.test(plays.match), false, 'a Leads page never highlights Plays')
  assert.equal((nav.match(/label: 'Plays'/g) ?? []).length, 1, 'one Plays item: the sidebar and the phone menu share it')
})

test('/app/plays renders the saved-play list and never forwards to Leads', () => {
  assert.ok(/import PlaysClient from '\.\/plays-client'/.test(page) && /return <PlaysClient \/>/.test(page), 'the route renders PlaysClient')
  assert.equal(/redirect\(|location\.(replace|assign|href\s*=)|router\.(push|replace)/.test(page + client), false, 'no redirect away from Plays')
  for (const k of ['audience', 'signal', 'schedule', 'last-run', 'next-run']) assert.ok(client.includes(`'${k}'`), `each play shows ${k}`)
  for (const id of ['play-status', 'play-toggle', 'play-delete', 'play-runs-toggle']) assert.ok(client.includes(`"${id}"`), `each play has ${id}`)
  assert.ok(client.includes("fetch('/api/watch')") || client.includes("'/api/watch'"), 'reads the weekly plays')
  assert.ok(client.includes("'/api/monitors'"), 'reads the scheduled monitors')
})
