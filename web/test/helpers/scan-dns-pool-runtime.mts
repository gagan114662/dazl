// #1463: runs in its own process (UV_THREADPOOL_SIZE=4, Node's default, set by the parent test). The scan's connect-time lookup
// must never take a libuv pool thread: those 4 threads also read every /_next/static chunk, so a crawl resolving slow names
// held the whole app on "Opening your workspace…" until the scan ended (prod run af02437c).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { readFile } from 'node:fs/promises'
import { guardedLookup } from '../../lib/scan/fetch-page.ts'
import { defaultLookup } from '../../lib/net/public-fetch.ts'

// A DNS server on loopback that receives every query and never answers: a dead name, held as long as the resolver waits.
const silent = dgram.createSocket('udp4')
let queries = 0
silent.on('message', () => { queries++ })
await new Promise<void>(r => silent.bind(0, '127.0.0.1', () => r()))
const port = (silent.address() as { port: number }).port
const dns = await import('../../lib/net/scan-dns.ts').catch(() => null)
dns?.setScanDnsServersForTest([`127.0.0.1:${port}`])

const poolLookups = () => process.getActiveResourcesInfo().filter(x => x === 'GetAddrInfoReqWrap').length

test('#1463 eight scan lookups of dead names take no pool thread, and file reads stay instant meanwhile', async () => {
  const names = Array.from({ length: 8 }, (_, i) => `dead-${i}.scan-1463.test`)
  const done = names.map(n => new Promise<string>(res => guardedLookup(n, { all: true }, (err: unknown) => res(err ? 'error' : 'ok'))))
  const viaFetch = names.slice(0, 4).map(n => defaultLookup(n).then(() => 'ok', () => 'error'))
  assert.equal(poolLookups(), 0, 'no getaddrinfo request is holding a libuv pool thread')
  const t0 = performance.now()
  await Promise.all(Array.from({ length: 8 }, () => readFile(new URL('../../package.json', import.meta.url))))
  const readMs = performance.now() - t0
  console.log(`SCAN_DNS reads=${readMs.toFixed(1)}ms pool_lookups=${poolLookups()} queries_seen=${queries}`)
  assert.ok(readMs < 200, `8 file reads finished in ${readMs.toFixed(0)}ms while 12 lookups hang`)
  const results = await Promise.all([...done, ...viaFetch])
  assert.deepEqual(new Set(results), new Set(['error']), 'a dead name fails (bounded), never resolves')
  assert.ok(queries > 0, 'the lookups went to the resolver the test controls')
  silent.close()
})
