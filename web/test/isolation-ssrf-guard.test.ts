// Pins the SSRF-guard semantics that the SEO-audit / newsjack / CRM-webhook
// remediation (docs/security/ssrf-remediation-proposal.md) reuses. These exercise
// lib/net/public-fetch.ts through its injected lookup/fetch seams - no network.
// A failure here means the guarded fetcher the fix depends on has regressed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchPublicHtml, isPublicIp, pinnedLookup, resolvePublic, type Lookup } from '../lib/net/public-fetch.ts'

test('isPublicIp rejects loopback, private, link-local/metadata, CGNAT and reserved space', () => {
  for (const bad of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3']) {
    assert.equal(isPublicIp(bad), false, bad)
  }
  for (const good of ['8.8.8.8', '1.1.1.1', '203.0.114.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicIp(good), true, good)
  }
})

test('resolvePublic refuses a hostname when ANY resolved address is non-public', async () => {
  const mixed: Lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]
  assert.equal(await resolvePublic('sneaky.example', mixed), null)
  const allPublic: Lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]
  assert.deepEqual(await resolvePublic('ok.example', allPublic), [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }])
  // Literal IPs skip DNS but are held to the same rule.
  assert.equal(await resolvePublic('169.254.169.254', async () => { throw new Error('must not be called') }), null)
  assert.deepEqual(await resolvePublic('8.8.8.8', async () => { throw new Error('must not be called') }), [{ address: '8.8.8.8', family: 4 }])
})

test('pinnedLookup serves only the validated address - no second DNS answer can replace it', () => {
  const lookup = pinnedLookup({ address: '8.8.8.8', family: 4 })
  lookup('anything.example', {}, (_e: unknown, address: string | { address: string; family: number }[], family?: number) => {
    assert.equal(typeof address === 'string' ? address : address[0].address, '8.8.8.8')
    assert.equal(typeof address === 'string' ? family : address[0].family, 4)
  })
})

const pubLookup: Lookup = async (host) => host === 'internal.example' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]
const htmlResponse = (url: string) => new Response('<html><title>t</title></html>', { status: 200, headers: { 'content-type': 'text/html' } })

test('fetchPublicHtml blocks a redirect chain that hops to a non-public host', async () => {
  const redirects = async (url: string | URL | Request) => {
    const u = String(url)
    if (u.startsWith('https://start.example/')) return new Response(null, { status: 302, headers: { location: 'http://internal.example/latest/meta-data' } })
    return htmlResponse(u)
  }
  const r = await fetchPublicHtml('https://start.example/', { lookup: pubLookup, fetchImpl: redirects as typeof fetch })
  assert.deepEqual(r, { error: 'not_public' })
})

test('fetchPublicHtml rejects credentialed, nonstandard-port and non-http(s) URLs', async () => {
  const fetchImpl = (async (url: string | URL | Request) => htmlResponse(String(url))) as typeof fetch
  assert.deepEqual(await fetchPublicHtml('https://user:pass@example.com/', { lookup: pubLookup, fetchImpl }), { error: 'invalid' })
  assert.deepEqual(await fetchPublicHtml('https://example.com:8443/', { lookup: pubLookup, fetchImpl }), { error: 'invalid' })
  assert.deepEqual(await fetchPublicHtml('file:///etc/passwd', { lookup: pubLookup, fetchImpl }), { error: 'invalid' })
})

test('fetchPublicHtml gives up after the redirect cap instead of following forever', async () => {
  let calls = 0
  const loop = (async (url: string | URL | Request) => { calls++; return new Response(null, { status: 302, headers: { location: 'https://loop.example/' + calls } }) }) as typeof fetch
  const r = await fetchPublicHtml('https://loop.example/0', { lookup: pubLookup, fetchImpl: loop })
  assert.deepEqual(r, { error: 'blocked' })
  assert.ok(calls <= 5, `expected bounded redirect following, got ${calls}`)
})
