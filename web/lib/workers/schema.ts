// The schema language a worker declares its input and output in (lib/workers/definition.ts): a small, closed subset of
// JSON Schema. Every value is plain JSON data; anything else (a class instance, a function, a symbol, a non-finite
// number, an unpaired surrogate, a key the schema does not name, nesting past MAX_DEPTH) is refused, never coerced.
// Objects are always closed: a key the schema does not declare fails, so a payload cannot smuggle extra fields.

export type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[] }
  | { type: 'array'; items: Schema; maxItems: number }
  | { type: 'string'; maxLength: number; enum?: string[] }
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'null' }

export const MAX_DEPTH = 16
const MAX_PROPS = 64
const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}
const nonNegInt = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max

// Is `s` itself a well-formed schema? Returns the first problem, or null. Run on every definition before it is
// registered, so a malformed schema can never reach validate().
export function checkSchema(s: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return 'schema too deep'
  if (!isPlain(s)) return 'schema must be an object'
  const t = s.type
  if (typeof t !== 'string' || !TYPES.includes(t)) return 'schema type unknown'
  const allowed: Record<string, string[]> = {
    object: ['type', 'properties', 'required'], array: ['type', 'items', 'maxItems'], string: ['type', 'maxLength', 'enum'],
    integer: ['type', 'minimum', 'maximum'], number: ['type', 'minimum', 'maximum'], boolean: ['type'], null: ['type'],
  }
  for (const k of Object.keys(s)) if (!allowed[t].includes(k)) return `schema key ${k} not allowed for ${t}`
  if (t === 'object') {
    if (!isPlain(s.properties)) return 'object schema needs properties'
    const keys = Object.keys(s.properties)
    if (keys.length > MAX_PROPS) return 'too many properties'
    for (const k of keys) {
      if (!KEY.test(k)) return `property name ${k.slice(0, 40)} not allowed`
      const e = checkSchema(s.properties[k], depth + 1)
      if (e) return `${k}: ${e}`
    }
    if (s.required !== undefined) {
      if (!Array.isArray(s.required) || !s.required.every(r => typeof r === 'string' && Object.hasOwn(s.properties as object, r))) return 'required names an undeclared property'
    }
  } else if (t === 'array') {
    if (!nonNegInt(s.maxItems, 10_000)) return 'array schema needs maxItems (0..10000)'
    return checkSchema(s.items, depth + 1)
  } else if (t === 'string') {
    if (!nonNegInt(s.maxLength, 100_000)) return 'string schema needs maxLength (0..100000)'
    if (s.enum !== undefined && !(Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every(e => typeof e === 'string'))) return 'enum must be a non-empty list of strings'
  } else if (t === 'integer' || t === 'number') {
    for (const k of ['minimum', 'maximum'] as const) if (s[k] !== undefined && !(typeof s[k] === 'number' && Number.isFinite(s[k]))) return `${k} must be a finite number`
  }
  return null
}

// Does `v` conform to `s`? Returns the first problem as a short path-tagged message (no values echoed), or null.
export function validate(s: Schema, v: unknown, path = '$', depth = 0): string | null {
  if (depth > MAX_DEPTH) return `${path}: too deep`
  switch (s.type) {
    case 'null': return v === null ? null : `${path}: expected null`
    case 'boolean': return typeof v === 'boolean' ? null : `${path}: expected boolean`
    case 'integer':
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${path}: expected ${s.type}`
      if (s.type === 'integer' && !Number.isSafeInteger(v)) return `${path}: expected integer`
      if (s.minimum !== undefined && v < s.minimum) return `${path}: below minimum`
      if (s.maximum !== undefined && v > s.maximum) return `${path}: above maximum`
      return null
    }
    case 'string': {
      if (typeof v !== 'string') return `${path}: expected string`
      if (v.length > s.maxLength) return `${path}: too long`
      if (LONE_SURROGATE.test(v)) return `${path}: not well-formed text`
      if (s.enum && !s.enum.includes(v)) return `${path}: not an allowed value`
      return null
    }
    case 'array': {
      if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return `${path}: expected array`
      if (v.length > s.maxItems) return `${path}: too many items`
      for (let i = 0; i < v.length; i++) {
        if (!Object.hasOwn(v, i)) return `${path}[${i}]: missing`
        const e = validate(s.items, v[i], `${path}[${i}]`, depth + 1)
        if (e) return e
      }
      return null
    }
    case 'object': {
      if (!isPlain(v)) return `${path}: expected object`
      if (Object.getOwnPropertySymbols(v).length) return `${path}: unexpected key`
      for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties, k)) return `${path}: unexpected key`
      for (const r of s.required ?? []) if (!Object.hasOwn(v, r)) return `${path}.${r}: required`
      for (const [k, sub] of Object.entries(s.properties)) {
        if (!Object.hasOwn(v, k)) continue
        const e = validate(sub, v[k], `${path}.${k}`, depth + 1)
        if (e) return e
      }
      return null
    }
  }
  return `${path}: unknown schema`
}

// Parse untrusted JSON text into a value checked against `s`, with a byte cap applied before parsing. Never throws.
export function parseChecked(s: Schema, text: unknown, maxBytes: number): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof text !== 'string') return { ok: false, error: 'not text' }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, error: 'too large' }
  let v: unknown
  try { v = JSON.parse(text) } catch { return { ok: false, error: 'not JSON' } }
  const e = validate(s, v)
  return e ? { ok: false, error: e } : { ok: true, value: v }
}
