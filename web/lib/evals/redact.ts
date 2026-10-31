// PII redaction for traces of real runs, applied BEFORE a trace is frozen into a World (worldFromTrace refuses an
// unredacted real trace). Replacement is consistent across the whole trace - the same email becomes the same token in
// the page text, the model's reply and the lead - so a quote or contact that matched the page before still matches
// after, and the replay reaches the same verdicts on the same structure.
//
// Redacted: credentials (below), email local parts (the domain is kept because contact-domain checks need it; a domain
// can still identify a small company), phone digits (separators kept, so phone-shaped values stay phone-shaped), LinkedIn
// /in/ slugs, and every person name the run itself extracted (a "name" field in a model reply or a lead). KNOWN LIMIT: a
// person named only in page text, never extracted as a lead or contact name, is not found by this pass, and domains are
// kept. `redacted: true` means this pass ran: it is not permission to publish and not proof of anonymisation. Recorded
// Worlds are private, tenant-scoped and unpublished (docs/design/agent-evals.md, "Redaction").
//
// Credentials are found two ways, and both run over EVERY string of the trace (values, object keys, span errors, names,
// labels, metadata) and inside any string that parses as JSON, however deep:
//   1. STRUCTURALLY, by field name. A key is credential-named when one of its words - split on `_`, `-`, `.`, space and
//      camelCase, lower-cased - is in CREDENTIAL_WORDS (token, secret, key, password, credential, auth, cookie, session,
//      signature, jwt, pat…), or the key with its separators removed ends in a GLUED marker (accesstoken, clientsecret,
//      sessionid…) that people write without a separator, or contains passw/authoriz/authentication. So refresh_token,
//      refreshToken, REFRESH-TOKEN, x-api-key, clientSecret,
//      Set-Cookie and session_id all count, at any nesting. Under such a key every string is replaced by `[secret]`,
//      through nested objects and arrays (a cookie given as {name, value}, credentials given as a list). The same names
//      are recognised as URL query parameters and as `name: value` / `name=value` / `"name": "value"` in prose, a
//      prompt or an error message, where the WHOLE assigned value goes: a quoted value to its closing quote, spaces and
//      all (`password: "two words"`), an unquoted one to the next delimiter. A NUMBER assigned to a credential name is a
//      secret too (password=493827, otp: 493827, `{"token": 112233}`) UNLESS the name is count-shaped: it has a count or
//      limit word (max_tokens, input_tokens, token_count, num_keys) or only plural credential words (`tokens: 5`), where a
//      bare number is a count and stays. Booleans and null are never redacted; a number under an ordinary name (page,
//      expires_in) never is; a number nested inside a credential-named object keeps its own key's judgment.
//   2. By FAMILY, for a value with no name next to it: provider keys (sk-ant-, sk-, sk-proj-, sk_live_/pk_test_/rk_…),
//      GitHub (ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_), GitLab glpat-, npm_, Slack xox*/xapp-, AWS AKIA,
//      Google AIza, JWTs, Bearer/Basic authorization values, PEM private-key blocks and Cookie/Set-Cookie header lines.
// Each credential becomes the fixed marker `[secret]` (never a hash: a hash of a secret is still a secret). The rule errs
// toward redacting: a prose `key: London` or a JSON field named `secretary` loses its value, which a private debugging
// trace can afford and a leaked credential cannot. NOT covered: an opaque value with no known prefix and no credential
// name next to it (a bare 40-character hex string in page text is a hash as often as a key).
import { createHmac, randomBytes } from 'node:crypto'
import type { Trace } from './trace.ts'

const SECRET = '[secret]'
// The lookbehind makes this linear: an address can only begin where a run of local-part characters begins, and without
// it the greedy local part is rescanned from every character of a long word (a 200k-character body took ~90 s).
const EMAIL = /(?<![A-Z0-9._%+-])([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi
const PHONE = /\+?\d[\d\s().-]{6,}\d/g
const LINKEDIN = /(linkedin\.com\/in\/)([A-Za-z0-9_%-]+)/gi

// Words that make a field name a credential name (whole words of the split key), and markers that count anywhere in
// the key because they are commonly written glued together.
const CREDENTIAL_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'key', 'keys', 'apikey', 'password', 'passwords', 'passwd', 'pwd', 'pass', 'passphrase',
  'credential', 'credentials', 'creds', 'passcode', 'auth', 'authorization', 'authentication', 'oauth', 'cookie', 'cookies', 'session', 'sessionid', 'signature', 'sig', 'jwt', 'bearer',
  'pat', 'otp', 'totp', 'csrf', 'xsrf'])
const GLUED_END = ['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'passphrase', 'apikey', 'cookie', 'cookies', 'credential', 'credentials', 'privatekey', 'accesskey', 'secretkey', 'signingkey', 'sessionid', 'jwt', 'csrf']
const GLUED_ANY = ['passw', 'authoriz', 'authentication']
const keyWords = (k: string): string[] => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
export function isCredentialKey(k: string): boolean {
  const compact = k.toLowerCase().replace(/[^a-z0-9]/g, '')
  return keyWords(k).some(w => CREDENTIAL_WORDS.has(w)) || GLUED_END.some(g => compact.endsWith(g)) || GLUED_ANY.some(g => compact.includes(g))
}
// A credential-named key under which a bare NUMBER is a count or a limit, not a secret: a count/limit word in the name
// (max_tokens, input_tokens, token_count, num_keys, cache_read_tokens), or only plural credential words (tokens, keys).
// Strings under such a key are still secrets; only the numeric exception reads this.
const COUNT_WORDS = new Set(['max', 'min', 'limit', 'limits', 'count', 'counts', 'num', 'number', 'total', 'input', 'output', 'used', 'usage', 'remaining', 'cache', 'cached',
  'prompt', 'completion', 'reasoning', 'budget', 'size', 'len', 'length', 'bytes', 'chars', 'per', 'rate'])
const PLURAL_CREDENTIAL = new Set(['tokens', 'keys', 'secrets', 'credentials', 'creds', 'cookies', 'passwords'])
export function isCountKey(k: string): boolean {
  const ws = keyWords(k), cw = ws.filter(w => CREDENTIAL_WORDS.has(w))
  return ws.some(w => COUNT_WORDS.has(w)) || (cw.length > 0 && cw.every(w => PLURAL_CREDENTIAL.has(w)))
}
const NUMBER = /^-?\d+(?:\.\d+)?$/
// A number assigned to a credential name is a secret unless the name is count-shaped (text and JSON alike).
const numberIsSecret = (k: string): boolean => isCredentialKey(k) && !isCountKey(k)

// Families: run first, so a key is gone before any other pattern can reshape it.
const FAMILIES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET],
  [/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{8,})/g, SECRET],
  [/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})\b/g, SECRET],
  [/\b(?:xox[abprse]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, SECRET],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, SECRET],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${SECRET}`],
  [/\bBasic\s+[A-Za-z0-9+\/]{16,}=*/g, `Basic ${SECRET}`],
  [/\b(Set-Cookie|Cookie)\s*:\s*[^\n"'}]+/gi, `$1: ${SECRET}`],
]
// `name: value`, `name=value`, `"name": "value"` in prose, a URL query or an error message, when the name is credential-
// named: the WHOLE assigned value goes. A quoted value (the quote is captured, never consumed) runs to its closing quote,
// whatever it holds - spaces, delimiters, digits; an escaped quote inside does not close it, and with no closing quote it
// runs to the end of the line. An unquoted value runs to the next delimiter. An authorization scheme word (Bearer/Basic)
// stays. A bare unquoted number stays only under a count-shaped name (max_tokens=300, tokens: 5); under password, otp,
// token, api_key it is the secret. Only a credential name consumes its value: after `https:` or `page=` the scan goes
// on inside what follows, so the `refresh_token=` in a URL's query is still found. A name starts only where a word
// starts (the lookbehind): tried from every character, the greedy name would be rescanned once per character of a long
// word, quadratic on a big body.
const NAME_SEP = /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]\s*(["']?)/g
const UNQUOTED = /[^\s"'&,;})]+/y
const SCHEME = /^(?:Bearer|Basic)\s+/i
const SCHEME_AT = /(?:Bearer|Basic)\s+/iy
function closingQuote(s: string, from: number, q: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === q) return i
    if (s[i] === '\n') return -1
  }
  return -1
}
function redactAssigned(s: string): string {
  let out = '', last = 0
  NAME_SEP.lastIndex = 0
  for (let m = NAME_SEP.exec(s); m; m = NAME_SEP.exec(s)) {
    if (!isCredentialKey(m[1])) continue
    const quote = m[2], from = NAME_SEP.lastIndex
    let end: number
    if (quote) {
      const close = closingQuote(s, from, quote), nl = s.indexOf('\n', from)
      end = close >= 0 ? close : nl >= 0 ? nl : s.length
    } else {
      // a scheme word and its value are one assignment: `auth: Bearer xyz`
      SCHEME_AT.lastIndex = from
      UNQUOTED.lastIndex = SCHEME_AT.exec(s) ? SCHEME_AT.lastIndex : from
      if (!UNQUOTED.exec(s)) continue
      end = UNQUOTED.lastIndex
    }
    const value = s.slice(from, end)
    const scheme = SCHEME.exec(value)?.[0] ?? ''
    const body = value.slice(scheme.length)
    if (body === '' || body === SECRET) continue
    if (!quote && NUMBER.test(body) && !numberIsSecret(m[1])) continue
    out += s.slice(last, from) + scheme + SECRET
    last = NAME_SEP.lastIndex = end
  }
  return out + s.slice(last)
}

function collectNames(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') {
    if (v.trim().startsWith('[') || v.trim().startsWith('{')) { try { collectNames(JSON.parse(v), out) } catch { /* not JSON */ } }
    return
  }
  if (Array.isArray(v)) { for (const x of v) collectNames(x, out); return }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (k === 'name' && typeof x === 'string' && x.trim().length >= 3) out.add(x.trim())
    else collectNames(x, out)
  }
}

const parseJson = (s: string): unknown => { const t = s.trim(); if (!t.startsWith('{') && !t.startsWith('[')) return undefined; try { return JSON.parse(s) as unknown } catch { return undefined } }

export function redactTrace(t: Trace, salt: Buffer = randomBytes(16)): Trace {
  const h = (s: string) => createHmac('sha256', salt).update(s).digest('hex')
  const names = new Set<string>()
  for (const s of t.spans) if (s.kind === 'model') collectNames(s.output, names)
  for (const l of t.output?.leads ?? []) if (l.name.trim().length >= 3) names.add(l.name.trim())
  const nameList = [...names].sort((a, b) => b.length - a.length) // longest first: "Ada Lovelace" before "Ada"
  const text = (s: string): string => {
    let r = s
    for (const [re, to] of FAMILIES) r = r.replace(re, to)
    r = redactAssigned(r)
    // The token has no punctuation: the verifier normalises it away, and the redacted contact must still be "on the page".
    r = r.replace(EMAIL, (_m, local: string, domain: string) => `p${h(local.toLowerCase()).slice(0, 10)}@${domain.toLowerCase()}`)
    // A phone has 9+ digits; ISO dates (8 digits, or a date then a time) are never touched, so event dates survive.
    r = r.replace(PHONE, m => { if (/^\d{4}-\d{2}-\d{2}/.test(m) || m.replace(/\D/g, '').length < 9) return m; const d = h(m.replace(/\D/g, '')); let i = 0; return m.replace(/\d/g, () => String(parseInt(d[i++ % d.length], 16) % 10)) })
    r = r.replace(LINKEDIN, (_m, pre: string, slug: string) => `${pre}redacted-${h(slug.toLowerCase()).slice(0, 10)}`)
    for (const n of nameList) r = r.split(n).join(`Person-${h(n).slice(0, 6)}`)
    return r
  }
  // A string that is JSON (a request or response body, a model reply, a value quoting another document) is redacted as
  // the structure it carries, so a credential-named field inside it is found by name; it is re-serialised only when
  // something in it changed, so an untouched body keeps its exact bytes.
  const str = (s: string, secret: boolean): string => {
    if (secret) return SECRET
    const parsed = parseJson(s)
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') return text(s)
    const before = JSON.stringify(parsed), after = JSON.stringify(deep(parsed, false))
    return after === before ? s : after
  }
  // Object keys too: a World keys pages and HTTP answers by URL, and a URL can carry an email, a profile slug or a token.
  // `secret` is true below a credential-named key: every string under it goes, whatever its own key is called. A number
  // goes only when its OWN key names a credential and is not count-shaped (`token: 112233` goes, `max_tokens: 300` and a
  // nested `expires_in: 3600` stay).
  const deep = (v: unknown, secret: boolean): unknown =>
    typeof v === 'string' ? str(v, secret)
      : Array.isArray(v) ? v.map(x => deep(x, secret))
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), typeof x === 'number' && numberIsSecret(k) ? SECRET : deep(x, secret || isCredentialKey(k))]))
          : v
  // EVERY string of the trace goes through the pass - span errors (an inner call's error message can quote a URL, a
  // header or an address), names, the agent label, metadata - except the structural identifiers this module's own code
  // wrote (trace and span ids, kinds, the path), which are put back as they were.
  const all = deep(t, false) as Trace
  return { ...all, v: t.v, kind: t.kind, id: t.id, path: t.path, redacted: true, spans: all.spans.map((s, i) => ({ ...s, id: t.spans[i].id, kind: t.spans[i].kind })) }
}
