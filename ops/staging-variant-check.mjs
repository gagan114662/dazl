#!/usr/bin/env node
// Staging variant check (issue #673/#780 deploy path). DAZL_ENV and PUBLIC_BASE_URL are read at BUILD time (banner in the
// prerendered shell, robots.txt, X-Robots-Tag in next.config.ts, canonical/og:url from SITE_BASE), so a runtime variable
// cannot turn a production build into a staging one. This proves a BOOTED build is the staging variant:
//   node ops/staging-variant-check.mjs <base url> <expected public base> <expected commit>
//   - /robots.txt disallows everything and names no sitemap
//   - every page answers X-Robots-Tag noindex (checked on / and /sign-in)
//   - the home shell carries the "Staging - test data" banner
//   - canonical and og:url point at the staging origin, and the production origin appears in neither
//   - /api/health/live reports the expected commit (skew stamp)
// Exit 0 only when all hold; otherwise exit 1 listing every failure. Prints one JSON line either way. No secrets.
import { pathToFileURL } from 'node:url'

export async function checkStagingVariant(base, publicBase, commit, fetchImpl = fetch) {
  const fails = []
  const get = async p => { const r = await fetchImpl(new URL(p, base)); return { r, text: await r.text() } }
  const pub = publicBase.replace(/\/+$/, '')
  const prod = 'https://dazl.ai'
  const robots = await get('/robots.txt')
  if (!/^\s*Disallow:\s*\/\s*$/m.test(robots.text)) fails.push('robots.txt does not disallow /')
  if (/^\s*Allow:/im.test(robots.text)) fails.push('robots.txt has an Allow rule')
  if (/^\s*Sitemap:/im.test(robots.text)) fails.push('robots.txt names a sitemap')
  const home = await get('/')
  for (const [name, res] of [['/', home], ['/sign-in', await get('/sign-in')]]) {
    if (!/noindex/i.test(res.r.headers.get('x-robots-tag') ?? '')) fails.push(`${name} has no X-Robots-Tag noindex`)
  }
  if (!home.text.includes('Staging - test data')) fails.push('home shell has no "Staging - test data" banner')
  if (!home.text.includes('data-testid="staging-banner"')) fails.push('home shell has no staging-banner element')
  const canonical = /<link[^>]*rel="canonical"[^>]*href="([^"]*)"|<link[^>]*href="([^"]*)"[^>]*rel="canonical"/i.exec(home.text)
  const ogUrl = /<meta[^>]*property="og:url"[^>]*content="([^"]*)"|<meta[^>]*content="([^"]*)"[^>]*property="og:url"/i.exec(home.text)
  const canon = canonical ? (canonical[1] ?? canonical[2]) : null, og = ogUrl ? (ogUrl[1] ?? ogUrl[2]) : null
  if (!canon) fails.push('home has no canonical link')
  else if (canon.replace(/\/+$/, '') !== pub) fails.push(`canonical is ${canon}, not ${pub}`)
  if (og && og.replace(/\/+$/, '') !== pub) fails.push(`og:url is ${og}, not ${pub}`)
  for (const v of [canon, og]) if (v && (v === prod || v.startsWith(`${prod}/`))) fails.push(`production origin in ${v}`)
  let live = null
  try { live = JSON.parse((await get('/api/health/live')).text) } catch { fails.push('/api/health/live is not JSON') }
  if (live && live.commit !== commit) fails.push(`health commit ${live.commit} is not ${commit}`)
  return fails
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, publicBase, commit] = process.argv.slice(2)
  if (!base || !publicBase || !commit) { console.error('usage: staging-variant-check.mjs <base> <public base> <commit>'); process.exit(2) }
  checkStagingVariant(base, publicBase, commit).then(fails => {
    console.log(JSON.stringify({ ok: fails.length === 0, base, publicBase, commit, fails }))
    process.exit(fails.length ? 1 : 0)
  }, e => { console.log(JSON.stringify({ ok: false, error: String(e) })); process.exit(1) })
}
