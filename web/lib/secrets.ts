import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Envelope encryption for tenant secrets (their LLM API keys).
//  - A fresh random 256-bit data key encrypts each secret (AES-256-GCM).
//  - The data key is wrapped with a master key that lives only in the server
//    environment (DAZL_MASTER_KEY, base64 of 32 random bytes), never in the DB.
//  - The context string (tenant + vendor) is bound as GCM additional data on
//    both layers, so a stored blob cannot be copied to another tenant's row.
// Rotation: add the new master key, re-wrap rows (decrypt+encrypt), remove the old one.

export function getMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.DAZL_MASTER_KEY
  if (!raw) throw new Error('DAZL_MASTER_KEY is not set')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('DAZL_MASTER_KEY must be base64 of exactly 32 bytes')
  return key
}

const b64 = (b: Buffer) => b.toString('base64')

function seal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad)
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return { iv, ct, tag: c.getAuthTag() }
}

function open(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(aad)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

export function encryptSecret(plaintext: string, context: string, master = getMasterKey()): string {
  const aad = Buffer.from(context)
  const dataKey = randomBytes(32)
  const body = seal(dataKey, Buffer.from(plaintext, 'utf8'), aad)
  const wrap = seal(master, dataKey, aad)
  dataKey.fill(0)
  return JSON.stringify({ v: 1, iv: b64(body.iv), ct: b64(body.ct), tag: b64(body.tag), wiv: b64(wrap.iv), wct: b64(wrap.ct), wtag: b64(wrap.tag) })
}

// Master-key rotation primitive: re-wrap a v1 envelope's data key from oldMaster
// to newMaster. The secret BODY (iv/ct/tag) is copied byte-identical - the
// plaintext is never materialized, and the AAD context is unchanged, so a
// rewrapped blob decrypts to exactly the same secret under the same context.
// Fails CLOSED: unknown format/version, an oldMaster that cannot unwrap, or a
// corrupted blob all throw, and error messages never carry blob or key material.
export function rewrapSecret(blob: string, context: string, oldMaster: Buffer, newMaster: Buffer): { out: string; changed: boolean } {
  let o: Record<string, unknown>
  try { o = JSON.parse(blob) as Record<string, unknown> } catch { throw new Error('secret blob is not parseable') }
  if (o?.v !== 1 || ['iv', 'ct', 'tag', 'wiv', 'wct', 'wtag'].some(k => typeof o[k] !== 'string')) throw new Error('unsupported secret format version')
  const aad = Buffer.from(context)
  // Idempotence: already wrapped under the new master -> leave untouched.
  try {
    const k = open(newMaster, Buffer.from(o.wiv as string, 'base64'), Buffer.from(o.wct as string, 'base64'), Buffer.from(o.wtag as string, 'base64'), aad)
    k.fill(0)
    return { out: blob, changed: false }
  } catch { /* not wrapped under the new master yet - fall through */ }
  // Throws if oldMaster is wrong or the wrap is corrupted - fail closed.
  const dataKey = open(oldMaster, Buffer.from(o.wiv as string, 'base64'), Buffer.from(o.wct as string, 'base64'), Buffer.from(o.wtag as string, 'base64'), aad)
  try {
    const wrap = seal(newMaster, dataKey, aad)
    return { out: JSON.stringify({ v: 1, iv: o.iv, ct: o.ct, tag: o.tag, wiv: b64(wrap.iv), wct: b64(wrap.ct), wtag: b64(wrap.tag) }), changed: true }
  } finally { dataKey.fill(0) }
}

export function decryptSecret(blob: string, context: string, master = getMasterKey()): string {
  const o = JSON.parse(blob)
  if (o?.v !== 1) throw new Error('unsupported secret format')
  const aad = Buffer.from(context)
  const dataKey = open(master, Buffer.from(o.wiv, 'base64'), Buffer.from(o.wct, 'base64'), Buffer.from(o.wtag, 'base64'), aad)
  try {
    return open(dataKey, Buffer.from(o.iv, 'base64'), Buffer.from(o.ct, 'base64'), Buffer.from(o.tag, 'base64'), aad).toString('utf8')
  } finally {
    dataKey.fill(0)
  }
}
