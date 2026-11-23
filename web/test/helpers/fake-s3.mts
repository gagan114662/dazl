// A stand-in S3 endpoint on loopback for the #1080 off-host tests (scripts/backup/s3.mts with S3_ENDPOINT). It behaves
// like the bucket as the production box's WRITE-ONLY key sees it:
//   PUT /<bucket>/<key>              stored as <dir>/<bucket>/<key>; refused unless the SigV4 signature verifies with the
//                                    known key AND the body hashes to the signed x-amz-content-sha256 (as S3 does)
//   GET /<bucket>/?list-type=2&...   ListObjectsV2 XML, 3 keys a page (so paging is exercised); the prefix must be under
//                                    prod/ (the policy's s3:prefix condition), else 403 AccessDenied
//   GET or DELETE of an object       403 AccessDenied: the key cannot read or delete
// Every request is appended to <dir>.log as "METHOD path". Run as a child process (the tests use spawnSync, which blocks
// their own event loop):  node --experimental-strip-types fake-s3.mts DIR   -> prints "PORT <n>" once it listens.
// FAKE_S3_ACCESS_KEY / FAKE_S3_SECRET are the only key it accepts.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { signS3 } from '../../scripts/backup/s3.mts'

const dir = process.argv[2]
const creds = { accessKeyId: process.env.FAKE_S3_ACCESS_KEY ?? '', secretAccessKey: process.env.FAKE_S3_SECRET ?? '', region: process.env.FAKE_S3_REGION ?? 'ca-central-1' }
if (!dir || !creds.accessKeyId || !creds.secretAccessKey) { console.error('usage: FAKE_S3_ACCESS_KEY=.. FAKE_S3_SECRET=.. fake-s3.mts DIR'); process.exit(2) }
const err = (res: import('node:http').ServerResponse, status: number, code: string) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>test</Message></Error>`) }
const walk = (d: string, base = ''): string[] => !existsSync(d) ? [] : readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), base + e.name + '/') : [base + e.name])

createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c)).on('end', () => {
    const body = Buffer.concat(chunks), url = new URL(req.url ?? '/', 'http://x'), pathname = decodeURIComponent(url.pathname)
    appendFileSync(dir + '.log', `${req.method} ${pathname}${url.search ? '?' + [...url.searchParams.keys()].sort().join('&') : ''}\n`)
    const date = String(req.headers['x-amz-date'] ?? ''), m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date)
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '')
    if (!m) return err(res, 403, 'AccessDenied')
    const want = signS3({ method: req.method!, host: String(req.headers.host), path: pathname, query: Object.fromEntries(url.searchParams), payloadHash, creds, now: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) })
    if (req.headers.authorization !== want.headers.authorization) return err(res, 403, 'SignatureDoesNotMatch')
    if (createHash('sha256').update(body).digest('hex') !== payloadHash) return err(res, 400, 'XAmzContentSHA256Mismatch')
    const [, bucket, ...rest] = pathname.split('/'), key = rest.join('/')
    if (req.method === 'PUT' && key) {
      if (!key.startsWith('prod/')) return err(res, 403, 'AccessDenied')
      const f = path.join(dir, bucket, key); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, body)
      res.writeHead(200); return res.end()
    }
    if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      if (!prefix.startsWith('prod/')) return err(res, 403, 'AccessDenied')
      const keys = walk(path.join(dir, bucket)).filter(k => k.startsWith(prefix)).sort()
      const start = Number(url.searchParams.get('continuation-token') ?? 0), page = keys.slice(start, start + 3), more = start + 3 < keys.length
      const items = page.map(k => { const st = statSync(path.join(dir, bucket, k)); return `<Contents><Key>${k}</Key><LastModified>${st.mtime.toISOString()}</LastModified><ETag>&quot;x&quot;</ETag><Size>${st.size}</Size><StorageClass>STANDARD</StorageClass></Contents>` }).join('')
      res.writeHead(200, { 'content-type': 'application/xml' })
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>3</MaxKeys><IsTruncated>${more}</IsTruncated>${items}${more ? `<NextContinuationToken>${start + 3}</NextContinuationToken>` : ''}</ListBucketResult>`)
    }
    return err(res, 403, 'AccessDenied')   // reading or deleting an object: not this key
  })
}).listen(0, '127.0.0.1', function (this: import('node:net').Server) { console.log(`PORT ${(this.address() as import('node:net').AddressInfo).port}`) })
