// The crawl's fetcher (rawGet) asks for 'identity', but some servers compress anyway. REAL case (prod matrix mxprod5, 2026-11-14): https://ogletree.com/ answers
// `content-encoding: gzip` to `accept-encoding: identity` (checked with curl the same night). Read raw, the gzip bytes reached the company-name check, the firm's own
// site was refused (name_mismatch), the crawl fell through to a linked ogletree.ca, and the lead, whose event day is proven, was held at no_domain.
// SYNTHETIC here: the local HTTPS server and the page text. The self-signed throwaway pair is the one test/transport-absolute-deadline.test.ts uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { rawGet } from '../lib/connectors/sitecrawl.ts'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const src = readFileSync(new URL('./transport-absolute-deadline.test.ts', import.meta.url), 'utf8')
const pem = (name: string) => JSON.parse(`"${new RegExp(`const ${name} = '([^']+)'`).exec(src)![1]}"`) as string
const CERT = pem('CERT'), KEY = pem('KEY')
const loopback = (_h: string, _o: { all?: boolean }, cb: (...a: unknown[]) => void) => cb(null, '127.0.0.1', 4)
const PAGE = '<html><head><title>Ogletree Deakins | Employment Law Firm</title></head><body><h1>Ogletree Deakins</h1><p>Offices in Chicago, Atlanta and Boston.</p></body></html>'

async function serve(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void, path = '/') {
  const seen: (string | undefined)[] = []
  const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => { seen.push(req.headers['accept-encoding'] as string | undefined); handler(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try { return { r: await rawGet(`https://127.0.0.1:${port}${path}`, 0, 5_000, loopback as never), seen } } finally { server.close() }
}
const html = { 'content-type': 'text/html; charset=UTF-8' }

test('a body compressed against the request (gzip, x-gzip, deflate, br) is decoded before anyone reads it; the request still asks for identity', async () => {
  for (const [enc, body] of [['gzip', zlib.gzipSync(PAGE)], ['x-gzip', zlib.gzipSync(PAGE)], ['deflate', zlib.deflateSync(PAGE)], ['br', zlib.brotliCompressSync(PAGE)]] as const) {
    const { r, seen } = await serve((_q, res) => { res.writeHead(200, { ...html, 'content-encoding': enc }); res.end(body) })
    assert.equal(seen[0], 'identity', 'unchanged request')
    assert.equal(r?.status, 200); assert.equal(r?.body, PAGE, enc)
  }
  // control: an uncompressed body is read exactly as before
  const plain = await serve((_q, res) => { res.writeHead(200, html); res.end(PAGE) })
  assert.equal(plain.r?.body, PAGE)
})

test('an encoding the fetcher cannot decode is not read as text (empty body), never handed on as bytes', async () => {
  const { r } = await serve((_q, res) => { res.writeHead(200, { ...html, 'content-encoding': 'compress' }); res.end(Buffer.from([0x1f, 0x9d, 0x90, 0x01, 0x02])) })
  assert.equal(r?.status, 200); assert.equal(r?.body, '')
})

test('the size limits count DECODED bytes: a small compressed body that expands past the text limit is cut there, not read whole', async () => {
  const huge = Buffer.alloc(20_000_000, 'a')   // 20 MB of text, about 20 KB gzipped
  const gz = zlib.gzipSync(huge)
  assert.ok(gz.length < 100_000)
  const { r } = await serve((_q, res) => { res.writeHead(200, { ...html, 'content-encoding': 'gzip' }); res.end(gz) })
  assert.ok(r, 'answered'); assert.equal(r!.body.length, 800_000, 'the stored body keeps its 800 KB cap'); assert.ok((r!.text ?? '').length <= 4_000_000, 'the text read stops at the 4 MB text limit')
})

test('a compressed body cut off mid-stream keeps what was decoded', async () => {
  const gz = zlib.gzipSync(PAGE + ' '.repeat(5000) + 'TAIL')
  const { r } = await serve((_q, res) => { res.writeHead(200, { ...html, 'content-encoding': 'gzip' }); res.end(gz.subarray(0, gz.length - 30)) })
  const full = PAGE + ' '.repeat(5000) + 'TAIL'
  assert.ok(r && r.body.length > 0 && full.startsWith(r.body), JSON.stringify(r?.body.slice(0, 80)))
  assert.match(r!.body, /Ogletree Deakins/, 'the decoded part is kept, not dropped')
})
