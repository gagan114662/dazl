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
// the key because they are commonly written glued together. Keys are folded first (pässword -> password).
const CREDENTIAL_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'key', 'keys', 'apikey', 'password', 'passwords', 'passwd', 'pwd', 'pass', 'passphrase',
  'credential', 'credentials', 'creds', 'passcode', 'auth', 'authorization', 'authentication', 'authenticate', 'oauth', 'cookie', 'cookies', 'session', 'sessionid', 'signature', 'sig', 'jwt', 'bearer',
  'pat', 'otp', 'totp', 'csrf', 'xsrf'])
const GLUED_END = ['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'passphrase', 'apikey', 'cookie', 'cookies', 'credential', 'credentials', 'privatekey', 'accesskey', 'secretkey', 'signingkey', 'sessionid', 'jwt', 'csrf']
const GLUED_ANY = ['passw', 'authoriz', 'authentication']
const fold = (k: string): string => k.normalize('NFKD').replace(/[̀-ͯ]/g, '')
const keyWords = (k: string): string[] => fold(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
export function isCredentialKey(k: string): boolean {
  const compact = fold(k).toLowerCase().replace(/[^a-z0-9]/g, '')
  return keyWords(k).some(w => CREDENTIAL_WORDS.has(w)) || GLUED_END.some(g => compact.endsWith(g)) || GLUED_ANY.some(g => compact.includes(g))
}
// A credential-named key under which a bare NUMBER is a count, a limit or a lifetime, not a secret. ONLY token/key names
// can be count-shaped (max_tokens, input_tokens, token_count, num_keys, cache_read_tokens, `tokens: 5`, `keys: 2`):
// password, passcode, otp, totp, pin, secret, session, cookie, signature are never counts, whatever else the name says
// (otp_number, input_password). Strings under any credential key are still secrets; only the numeric rule reads this.
const COUNT_WORDS = new Set(['max', 'min', 'limit', 'limits', 'count', 'counts', 'num', 'number', 'total', 'input', 'output', 'used', 'usage', 'remaining', 'cache', 'cached',
  'prompt', 'completion', 'reasoning', 'budget', 'size', 'len', 'length', 'bytes', 'chars', 'per', 'rate',
  'expires', 'expiry', 'expire', 'expiration', 'ttl', 'age', 'maxage', 'timeout', 'iat', 'exp', 'nbf', 'issued', 'created', 'updated', 'time', 'timestamp', 'ms', 'seconds', 'secs', 'duration', 'version'])
const COUNTABLE = new Set(['token', 'tokens', 'key', 'keys'])
const hasCountWord = (k: string): boolean => keyWords(k).some(w => COUNT_WORDS.has(w))
export function isCountKey(k: string): boolean {
  const ws = keyWords(k), cw = ws.filter(w => CREDENTIAL_WORDS.has(w))
  return cw.length > 0 && cw.every(w => COUNTABLE.has(w)) && (ws.some(w => COUNT_WORDS.has(w)) || cw.every(w => w === 'tokens' || w === 'keys'))
}
const NUMBER = /^-?\d+(?:\.\d+)?$/
// A number assigned to a credential name is a secret unless the name is count-shaped (text and JSON alike).
const numberIsSecret = (k: string): boolean => isCredentialKey(k) && !isCountKey(k)
// Header-like names whose unquoted value runs to the END OF THE LINE: an Authorization value may be any scheme with any
// syntax (Token x, Digest username="u", response="..."), a Cookie value is a whole `a=1; b=2` list.
const LINE_WORDS = new Set(['authorization', 'authenticate', 'authentication', 'cookie', 'cookies'])
const lineValued = (k: string): boolean => { const ws = keyWords(k); return ws.some(w => LINE_WORDS.has(w)) || fold(k).toLowerCase().replace(/[^a-z0-9]/g, '').includes('authoriz') || ws.join('_') === 'auth' || ws.join('_') === 'auth_header' || ws.join('_') === 'basic_auth' }

// Families: run first, so a key is gone before any other pattern can reshape it.
const FAMILIES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET],
  [/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{8,})/g, SECRET],
  [/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})\b/g, SECRET],
  [/\b(?:xox[abprse]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, SECRET],
  // a JWT: header.payload.signature, the first two base64url of a JSON object (always "eyJ"), however short
  [/\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, SECRET],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${SECRET}`],
  [/\bBasic\s+[A-Za-z0-9+\/]{8,}=*/g, `Basic ${SECRET}`],
  // the password of a URL's userinfo: scheme://user:password@host (a connection string, a proxied URL, a database DSN)
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s\/:@"'<>]+:)([^\s\/@"'<>]+)@/gi, `$1${SECRET}@`],
  // a cookie header line, whole: every pair, quoted or not, to the end of the line
  [/\b(Set-Cookie|Cookie)\s*:\s*[^\n]+/gi, `$1: ${SECRET}`],
]
// HTML attribute pairs: <input name="csrf_token" value="..."> and <meta name="csrf-token" content="...">, in either
// attribute order. The attribute's name decides, exactly as a key does.
const HTML_NAME_VALUE = /(<[a-z][^<>]*?\bname\s*=\s*["']?)([^"'\s<>]+)(["']?[^<>]*?\b(?:value|content)\s*=\s*)(["'])([^"'<>]*)\4/gi
const HTML_VALUE_NAME = /(<[a-z][^<>]*?\b(?:value|content)\s*=\s*)(["'])([^"'<>]*)\2([^<>]*?\bname\s*=\s*["']?)([^"'\s<>]+)/gi
function redactHtmlAttributes(s: string): string {
  if (!s.includes('<')) return s
  return s.replace(HTML_NAME_VALUE, (m, a: string, name: string, b: string, q: string, v: string) => isCredentialKey(name) && v !== SECRET ? `${a}${name}${b}${q}${SECRET}${q}` : m)
    .replace(HTML_VALUE_NAME, (m, a: string, q: string, v: string, b: string, name: string) => isCredentialKey(name) && v !== SECRET ? `${a}${q}${SECRET}${q}${b}${name}` : m)
}
// A URL query value that is percent-encoded can carry its own assignments (?next=%2Flogin%3Fpassword%3D...) or a JSON
// document (?d=%7B%22api_key%22...): it is decoded, redacted by the same rules and re-encoded (the marker stays readable).
const QUERY_VALUE = /([?&][^=&\s"'<>#?]+=)([^&\s"'<>]*%[0-9A-Fa-f]{2}[^&\s"'<>]*)/g
function redactEncodedQueryValues(s: string, core: (x: string) => string): string {
  if (!s.includes('%')) return s
  return s.replace(QUERY_VALUE, (m, k: string, v: string) => {
    let d: string
    try { d = decodeURIComponent(v) } catch { return m }
    const r = core(d)
    return r === d ? m : k + encodeURIComponent(r).replace(/%5Bsecret%5D/g, SECRET)
  })
}
// `name: value`, `name=value`, `name => value`, `"name": "value"` in prose, a URL query, an error message or a JSON
// fragment, when the name is credential-named: the WHOLE assigned value goes.
//   - A quoted value (the quote is captured, never consumed; a JSON-escaped \" counts as a quote, so JSON embedded as a
//     string in a log line is covered) runs to its closing quote, whatever it holds - spaces, delimiters, digits; an
//     escaped quote inside does not close it, and with no closing quote on the line it runs to the end of the line.
//   - An unquoted value that opens an object or array (`"session": {"id": ...}`, `credentials: [...]` in text that is
//     not JSON as a whole: a body cut by the recorder's cap, NDJSON, a JS object literal, JSON inside a script tag) runs
//     to the matching bracket, or to the end of the string when the cut removed it.
//   - Under a header-like name (authorization, cookie) an unquoted value runs to the end of the line, so `Token x`,
//     `Digest username="u", response="..."` and a cookie list go whole; `Bearer x` / `Basic x` keep the scheme word.
//   - Any other unquoted value runs to the next delimiter (whitespace , ; & } ) quote).
//   - A bare unquoted number stays only under a count-shaped name (max_tokens=300, tokens: 5); under password, otp,
//     token, api_key it is the secret.
// Only a credential name consumes its value: after `https:` or `page=` the scan goes on inside what follows, so the
// `refresh_token=` in a URL's query is still found. A name starts only where a word starts (the lookbehind): tried from
// every character, the greedy name would be rescanned once per character of a long word, quadratic on a big body.
// NOT covered, by design (documented limits): an unquoted value with spaces (`password: correct horse battery`) keeps
// everything after its first word; prose (`the password is X`, `password - X`) and names that are not credential words
// (verification_code, pin as a key) are not assignments to a credential name.
const NAME_SEP = /(?<![\p{L}\p{N}_.-])([\p{L}][\p{L}\p{N}_.-]*)\\?["']?\s*(?:=>|[:=])\s*(\\?["']?)/gu
const UNQUOTED = /[^\s"'&,;})]+/y
const SCHEME = /^(?:Bearer|Basic)\s+/i
const SCHEME_AT = /(?:Bearer|Basic)\s+/iy
// Index of the quote that closes a value opened by `q` (`"`, `'` or the JSON-escaped `\"`), or -1 when the line ends first.
function closingQuote(s: string, from: number, q: string): number {
  const escaped = q.length === 2
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1
    if (escaped) { if (s[i] === '\\' && s[i + 1] === q[1]) return i; if (s[i] === '\\') i++; continue }
    if (s[i] === '\\') { i++; continue }
    if (s[i] === q) return i
  }
  return -1
}
// Index just past the bracket matching the one at `at`, skipping quoted strings; -1 when the text ends first.
function closingBracket(s: string, at: number): number {
  let depth = 0, quote = ''
  for (let i = at; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1 }
  }
  return -1
}
const lineEnd = (s: string, from: number): number => { const nl = s.indexOf('\n', from); return nl >= 0 ? nl : s.length }
function redactAssigned(s: string): string {
  let out = '', last = 0
  NAME_SEP.lastIndex = 0
  for (let m = NAME_SEP.exec(s); m; m = NAME_SEP.exec(s)) {
    const name = m[1]
    if (!isCredentialKey(name)) continue
    const quote = m[2], from = NAME_SEP.lastIndex
    let end: number
    if (quote) {
      const close = closingQuote(s, from, quote)
      end = close >= 0 ? close : lineEnd(s, from)
    } else {
      // a scheme word and its value are one assignment: `auth: Bearer xyz`
      SCHEME_AT.lastIndex = from
      const start = SCHEME_AT.exec(s) ? SCHEME_AT.lastIndex : from
      if (s[start] === '{' || s[start] === '[') { const close = closingBracket(s, start); end = close >= 0 ? close : s.length }
      else if (start === from && lineValued(name)) end = lineEnd(s, from)
      else { UNQUOTED.lastIndex = start; if (!UNQUOTED.exec(s)) continue; end = UNQUOTED.lastIndex }
    }
    const value = s.slice(from, end)
    const scheme = SCHEME.exec(value)?.[0] ?? ''
    const body = value.slice(scheme.length).replace(/\s+$/, '')
    if (body === '' || body === SECRET) continue
    if (!quote && NUMBER.test(body) && !numberIsSecret(name)) continue
    out += s.slice(last, from) + scheme + SECRET
    last = NAME_SEP.lastIndex = from + scheme.length + body.length
  }
  return out + s.slice(last)
}

// Every `"name": "..."` a string carries, whether or not the string parses as JSON as a whole: a fenced reply
// ("```json\n[...]\n```"), a reply with a preamble ("Here you go: [...]") or a reply cut short still names people.
const NAME_FIELD = /"name"\s*:\s*"((?:[^"\\]|\\.)+)"/g
function collectNames(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') {
    if (v.trim().startsWith('[') || v.trim().startsWith('{')) { try { collectNames(JSON.parse(v), out) } catch { /* not JSON as a whole */ } }
    if (v.includes('"name"')) for (const m of v.matchAll(NAME_FIELD)) { try { const n = (JSON.parse(`"${m[1]}"`) as string).trim(); if (n.length >= 3) out.add(n) } catch { /* not a JSON string */ } }
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
  // Credentials: families, then assignments by name, then HTML attribute pairs, then the same inside percent-encoded
  // URL query values.
  const core = (x: string): string => {
    let r = x
    for (const [re, to] of FAMILIES) r = r.replace(re, to)
    r = redactHtmlAttributes(redactAssigned(r))
    return redactEncodedQueryValues(r, core)
  }
  const text = (s: string): string => {
    let r = core(s)
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
    const before = JSON.stringify(parsed), after = JSON.stringify(deep(parsed, false, false))
    return after === before ? s : after
  }
  // Object keys too: a World keys pages and HTTP answers by URL, and a URL can carry an email, a profile slug or a token.
  // `secret` is true below a credential-named key: every string under it goes, whatever its own key is called.
  // `secretNum` is true below a credential-named key that is not count-shaped: numbers there go too (`token: 112233`,
  // `{"cookie": {"name": "sid", "value": 12345}}`, `{"secrets": [493827]}`, `{"auth": {"pin": 4938}}`), except under a
  // key that names a count, limit or lifetime (`expires_in: 3600` under session, `max_tokens` anywhere). Booleans and
  // null never go.
  const deep = (v: unknown, secret: boolean, secretNum: boolean): unknown =>
    typeof v === 'string' ? str(v, secret)
      : typeof v === 'number' ? (secretNum ? SECRET : v)
        : Array.isArray(v) ? v.map(x => deep(x, secret, secretNum))
          : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => {
            const cred = isCredentialKey(k), count = cred ? isCountKey(k) : hasCountWord(k)
            return [text(k), deep(x, secret || cred, count ? false : secretNum || cred)]
          }))
            : v
  // EVERY string of the trace goes through the pass - span errors (an inner call's error message can quote a URL, a
  // header or an address), names, the agent label, metadata - except the structural identifiers this module's own code
  // wrote (trace and span ids, kinds, the path), which are put back as they were.
  const all = deep(t, false, false) as Trace
  return { ...all, v: t.v, kind: t.kind, id: t.id, path: t.path, redacted: true, spans: all.spans.map((s, i) => ({ ...s, id: t.spans[i].id, kind: t.spans[i].kind })) }
}
