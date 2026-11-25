import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const client = readFileSync(new URL('../app/app/plays/plays-client.tsx', import.meta.url), 'utf8')

test('#1779 Find leads now refreshes the Plays free-search count when the run is accepted', () => {
  const runNow = client.slice(client.indexOf('async function runNow('), client.indexOf('function markSeen('))
  assert.match(runNow, /if \(r\?\.status === 202[^\n]+\) \{[^}]*\bvoid loadUsage\(\)/,
    'refresh usage as soon as the accepted run can have spent a free search')
  assert.match(client, /const loadUsage = useCallback\(async \(\) => \{[^}]*fetch\('\/api\/usage'/,
    'read the current allowance from the same endpoint as the initial load')
  assert.match(client, /useEffect\(\(\) => \{\s*alive\.current = true\s*loadOnMount\.current\(\)\s*void loadUsage\(\)/)
})

test('#1779 Plays refreshes the count again when a followed run ends', () => {
  const follow = client.slice(client.indexOf('function follow('), client.indexOf('async function act('))
  assert.match(follow, /if \(r && runEnded\(r\.status, j\)\) \{[^}]*\bvoid loadUsage\(\)/,
    'a run that failed before any spend can return a free search')
})
