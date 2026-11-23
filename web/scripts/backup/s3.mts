// The S3 off-host destination with a WRITE-ONLY key (issue #1080): OFFHOST_DEST=s3:BUCKET/PREFIX.
// The production box holds an IAM key that may only s3:PutObject under the prefix and s3:ListBucket on it: it can add
// copies and see that they are there, and it can neither read one back nor delete one (the bucket's 30-day lifecycle
// rule expires them; ops/backup/aws-setup.sh creates the bucket, the user and that policy). So this file has exactly
// two operations, put and list, and nothing else: no get, no delete.
//   node --experimental-strip-types scripts/backup/s3.mts put FILE s3:BUCKET/PREFIX NAME    upload FILE as PREFIX/NAME
//   node --experimental-strip-types scripts/backup/s3.mts list s3:BUCKET/PREFIX [NAMEPREFIX] JSON: [{name,size,lastModified}]
//   node --experimental-strip-types scripts/backup/s3.mts verify s3:BUCKET/PREFIX NAME BYTES exit 0 when listed with that size
// Credentials come from the environment only (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION; on the box
// /etc/dazl-backup/s3.env, read by the systemd units). They are never an argument and never printed: an error names the
// operation, the HTTP status and S3's error code, nothing else.
// A put signs the SHA-256 of the body (x-amz-content-sha256): S3 refuses a body that does not hash to it, so an
// accepted upload is the bytes that were sent. No SDK: AWS Signature Version 4 over fetch, with a time bound
// (S3_TIMEOUT_S, a positive integer of seconds, default 120). S3_ENDPOINT is for tests only (loopback http or https).
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface S3Object { name: string; size: number; lastModified: string }
export interface S3Creds { accessKeyId: string; secretAccessKey: string; region: string }

const hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest()
// RFC 3986: everything but the unreserved characters is percent-encoded (encodeURIComponent leaves !'()* alone)
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const plainName = (n: string) => n.length > 0 && n.length <= 200 && /^[A-Za-z0-9._-]+$/.test(n) && !n.startsWith('.')

// s3:BUCKET/PREFIX -> its parts. The bucket has no dots (it is used as a TLS host name); the prefix is required, so the
// key's policy can be limited to it.
export function parseS3(spec: string): { bucket: string; prefix: string } {
  const m = /^s3:([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)\/?$/.exec(spec)
  if (!m) throw new Error('S3 destination must be s3:BUCKET/PREFIX (lowercase bucket without dots, a plain prefix)')
  return { bucket: m[1], prefix: m[2] }
}
export const s3Label = (spec: string) => `s3:${parseS3(spec).bucket}`

export function s3Creds(env: NodeJS.ProcessEnv = process.env): S3Creds {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim(), secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim(), region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION)?.trim()
  const missing = [!accessKeyId && 'AWS_ACCESS_KEY_ID', !secretAccessKey && 'AWS_SECRET_ACCESS_KEY', !region && 'AWS_REGION'].filter(Boolean)
  if (missing.length) throw new Error(`S3 credentials not set (${missing.join(', ')}): on the box they are in /etc/dazl-backup/s3.env`)
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region!)) throw new Error('AWS_REGION is not a region name')
  return { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, region: region! }
}

// AWS Signature Version 4 for one S3 request. Pure: the same inputs give the same headers (tested against the worked
// example in the S3 API reference). `path` is the unencoded absolute path; `query` the unencoded parameters.
export function signS3(o: { method: string; host: string; path: string; query?: Record<string, string>; payloadHash: string; creds: S3Creds; now: Date }): { headers: Record<string, string>; canonicalQuery: string; canonicalPath: string } {
  const amzDate = o.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8)
  const canonicalPath = o.path.split('/').map(enc).join('/')
  const canonicalQuery = Object.entries(o.query ?? {}).map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')
  const signed = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = [o.method, canonicalPath, canonicalQuery, `host:${o.host}`, `x-amz-content-sha256:${o.payloadHash}`, `x-amz-date:${amzDate}`, '', signed, o.payloadHash].join('\n')
  const scope = `${day}/${o.creds.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + o.creds.secretAccessKey, day), o.creds.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return {
    canonicalPath, canonicalQuery,
    headers: { 'x-amz-content-sha256': o.payloadHash, 'x-amz-date': amzDate, authorization: `AWS4-HMAC-SHA256 Credential=${o.creds.accessKeyId}/${scope},SignedHeaders=${signed},Signature=${signature}` },
  }
}

function timeoutMs(): number {
  const raw = process.env.S3_TIMEOUT_S?.trim()
  return (raw && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : 120) * 1000
}

// where the bucket is: the real virtual-hosted endpoint, or (tests) a path-style stand-in on loopback
function endpoint(bucket: string, region: string): { base: string; host: string; pathPrefix: string } {
  const raw = process.env.S3_ENDPOINT?.trim()
  if (!raw) { const host = `${bucket}.s3.${region}.amazonaws.com`; return { base: `https://${host}`, host, pathPrefix: '' } }
  const u = new URL(raw)
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error('S3_ENDPOINT must be https, or http on loopback (tests)')
  return { base: u.origin, host: u.host, pathPrefix: `/${bucket}` }
}

async function call(method: 'PUT' | 'GET', bucket: string, key: string, query: Record<string, string>, body: Buffer | null, what: string): Promise<string> {
  const creds = s3Creds(), ep = endpoint(bucket, creds.region)
  const path = `${ep.pathPrefix}/${key}`
  const s = signS3({ method, host: ep.host, path, query, payloadHash: hex(body ?? ''), creds, now: new Date() })
  let r: Response
  try {
    r = await fetch(`${ep.base}${s.canonicalPath}${s.canonicalQuery ? '?' + s.canonicalQuery : ''}`, { method, headers: s.headers, body: body ? new Uint8Array(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(timeoutMs()) })
  } catch (e) { throw new Error(`s3 ${what} failed (${e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'no answer from the endpoint'})`) }
  const text = await r.text()
  if (!r.ok) throw new Error(`s3 ${what} failed (HTTP ${r.status}${/<Code>([A-Za-z0-9]+)<\/Code>/.exec(text)?.[1] ? ' ' + /<Code>([A-Za-z0-9]+)<\/Code>/.exec(text)![1] : ''})`)
  return text
}

// upload FILE as PREFIX/NAME (a new object version each time: the bucket is versioned, nothing is overwritten for good)
export async function s3Put(spec: string, file: string, name: string): Promise<{ bytes: number }> {
  const { bucket, prefix } = parseS3(spec)
  if (!plainName(name)) throw new Error('refused file name')
  const body = readFileSync(file)
  await call('PUT', bucket, `${prefix}/${name}`, {}, body, 'put')
  return { bytes: body.length }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// every object directly under PREFIX/ whose name starts with namePrefix (all pages). Names with a "/" below the prefix
// or that are not plain file names are left out: the backup tools only ever write plain names.
export async function s3List(spec: string, namePrefix = ''): Promise<S3Object[]> {
  const { bucket, prefix } = parseS3(spec)
  if (namePrefix && !plainName(namePrefix)) throw new Error('refused name prefix')
  const out: S3Object[] = []; let token: string | undefined
  for (let page = 0; page < 100; page++) {
    const query: Record<string, string> = { 'list-type': '2', prefix: `${prefix}/${namePrefix}` }
    if (token) query['continuation-token'] = token
    const xml = await call('GET', bucket, '', query, null, 'list')
    if (!/<ListBucketResult[\s>]/.test(xml)) throw new Error('s3 list failed (not a listing)')
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const field = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(m[1])?.[1]
      const key = unxml(field('Key') ?? ''), size = Number(field('Size')), lastModified = field('LastModified') ?? ''
      if (!key.startsWith(prefix + '/')) continue
      const name = key.slice(prefix.length + 1)
      if (!plainName(name) || !Number.isFinite(size) || Number.isNaN(Date.parse(lastModified))) continue
      out.push({ name, size, lastModified })
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return out
    token = unxml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '')
    if (!token) throw new Error('s3 list failed (truncated listing without a continuation token)')
  }
  throw new Error('s3 list failed (more than 100 pages)')
}

const isMain = () => { try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]) } catch { return false } }
if (isMain()) {
  const [cmd, a, b, c] = process.argv.slice(2)
  try {
    if (cmd === 'put' && a && b && c) { const r = await s3Put(b, a, c); console.log(JSON.stringify({ type: 's3_put', ok: true, to: `${s3Label(b)}/${parseS3(b).prefix}/${c}`, bytes: r.bytes })) }
    else if (cmd === 'list' && a) console.log(JSON.stringify(await s3List(a, b ?? '')))
    else if (cmd === 'verify' && a && b && c && /^\d+$/.test(c)) {
      const hit = (await s3List(a, b)).find(o => o.name === b)
      if (!hit) throw new Error(`s3 verify failed (${b} is not in the listing after the upload)`)
      if (hit.size !== Number(c)) throw new Error(`s3 verify failed (${b} is listed with ${hit.size} bytes, ${c} were sent)`)
    } else { console.error('usage: s3.mts put FILE s3:BUCKET/PREFIX NAME | list s3:BUCKET/PREFIX [NAMEPREFIX] | verify s3:BUCKET/PREFIX NAME BYTES'); process.exit(2) }
  } catch (e) { console.error(`s3: ${e instanceof Error ? e.message : 'error'}`); process.exit(1) }
}
