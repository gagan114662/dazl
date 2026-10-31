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
//      secret too (password=493827, otp: 493827, `{"token": 112233}`) UNLESS the name is a token/key count or limit
//      (max_tokens, input_tokens, token_count, num_keys, `tokens: 5`), where a bare number is a count and stays. In JSON
//      the WHOLE value under a credential-named key goes whatever its type (object, array, byte map); booleans and null
//      are never redacted; a number under an ordinary name (page, expires_in) never is.
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
// Digits glued to a word are not part of it: token2, api_key2, key1, otp2, session2, 2fa_token.
const keyWords = (k: string): string[] => fold(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).map(w => w.replace(/^\d+|\d+$/g, '')).filter(Boolean)
export function isCredentialKey(k: string): boolean {
  const compact = fold(k).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '')
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
  // (the password may contain `@` and `/`; it ends at the last `@` before the host; a `?`, `#`, `&` or `=` ends the
  // authority, so `https://host:8080/path?u=a@b.example` has no password)
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s\/:@"'<>]+:)([^\s"'<>@?#&=]+(?:@[^\s"'<>@\/?#&=]+)*)@/gi, `$1${SECRET}@`],
  // a cookie header line, whole: every pair, quoted or not, to the end of the line
  [/\b(Set-Cookie|Cookie)\s*:\s*[^\n]+/gi, `$1: ${SECRET}`],
]
// HTML attribute pairs: <input name="csrf_token" value="..."> and <meta name="csrf-token" content="...">, in either
// attribute order, the attribute named by `name` or `id`, its value quoted or bare. The attribute's name decides, exactly
// as a key does. Each scan inside a tag is BOUNDED (2,000 characters): a page is attacker-controlled and this pass runs
// synchronously inside finish(), so an unbounded lazy scan would be quadratic in the length of one tag (a 400k-char tag
// took 12 s). A pair further apart than the bound is not found - documented.
const ATTR_VALUE = String.raw`(?:(["'])([^"'<>]*)\2|([^\s"'<>]+))`
const HTML_NAME_VALUE = new RegExp(String.raw`(<[a-z][^<>]{0,2000}?\b(?:name|id)\s*=\s*["']?)([^"'\s<>]+)(["']?[^<>]{0,2000}?\b(?:value|content)\s*=\s*)` + ATTR_VALUE.replace('\\2', '\\4'), 'gi')
const HTML_VALUE_NAME = new RegExp(String.raw`(<[a-z][^<>]{0,2000}?\b(?:value|content)\s*=\s*)` + ATTR_VALUE + String.raw`([^<>]{0,2000}?\b(?:name|id)\s*=\s*["']?)([^"'\s<>]+)`, 'gi')
function redactHtmlAttributes(s: string): string {
  if (!s.includes('<')) return s
  return s.replace(HTML_NAME_VALUE, (m, a: string, name: string, b: string, q: string | undefined, qv: string | undefined, bare: string | undefined) =>
    !isCredentialKey(name) || (qv ?? bare) === SECRET ? m : q ? `${a}${name}${b}${q}${SECRET}${q}` : `${a}${name}${b}${SECRET}`)
    .replace(HTML_VALUE_NAME, (m, a: string, q: string | undefined, qv: string | undefined, bare: string | undefined, b: string, name: string) =>
      !isCredentialKey(name) || (qv ?? bare) === SECRET ? m : q ? `${a}${q}${SECRET}${q}${b}${name}` : `${a}${SECRET}${b}${name}`)
}
// Percent-encoded text anywhere in a string - a URL's query, path or fragment, a redirect target, an encoded JSON
// document - can hide an assignment (%3Fpassword%3D..., %22api_key%22%3A..., &%70assword=) from the pass above. The
// string is decoded tolerantly (only valid %XX sequences; a malformed %zz never throws and never fails open), the
// assignment pass runs on the decoded shadow, and each hit is mapped back to the original and replaced there, so the
// surrounding encoding is kept. Repeated until the text stops changing, at most 3 times: a double-encoded value
// (%2522password%2522) is reached on the second pass.
const PCT = /%[0-9A-Fa-f]{2}/
function tolerantDecode(s: string): { text: string; map: number[] } | null {
  if (!PCT.test(s)) return null
  const map: number[] = []; let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { map.push(i); out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 }
    else { map.push(i); out += c }
  }
  map.push(s.length)
  return { text: out, map }
}
function redactEncoded(s: string): string {
  let dec = s, toOrig: number[] | null = null
  const hits: Hit[] = []
  for (let pass = 0; pass < 3; pass++) {
    const d = tolerantDecode(dec)
    if (!d) break
    const map: number[] = toOrig ? d.map.map(i => toOrig![i]) : d.map
    dec = d.text; toOrig = map
    for (const h of findAssigned(dec)) hits.push({ from: map[h.from], end: map[h.end] })
  }
  return applyHits(s, hits)
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
//   - A name that ends its line (`credentials:` then an indented block, `password:` then the value on the next line)
//     takes the whole indented block below it.
// COVERED, to be explicit: names starting with or glued to digits (2fa_token, token2, api_key2), percent-encoded names
// and separators (refresh%5Ftoken, password%3D, &%70assword=), double-encoded values, JSON-escaped quotes (\\"), values
// in a URL's path or fragment, count-word CHILD keys under a credential object ({"auth": {"time": 1}} goes whole; a
// count word exempts a number only under a count-shaped token/key parent: {"tokens": {"input": 5}}).
// NOT covered, by design (documented limits): an unquoted value with spaces (`password: correct horse battery`) keeps
// everything after its first word; prose (`the password is X`, `password - X`, `password → X`) and names that are not
// credential words (verification_code, pin as a key) are not assignments to a credential name; a bare `Basic xxxx`
// shorter than 8 characters with no name next to it is kept; an HTML attribute pair more than 2,000 characters apart
// inside one tag, or an apostrophe inside a quoted attribute value, is not found; a userinfo password containing `/`
// (`user:ab/x@host`) is not a URL password; an unbalanced `password: {` takes the rest of the string and an
// Authorization/Cookie name the rest of its line (fail closed); a company given under a reply's "name" field is
// pseudonymised like a person; JSON nested ~20k levels deep throws and nothing is stored (fail closed).
// A name may start with a digit (2fa_token) and carry a percent-encoded underscore (refresh%5Ftoken); `=` and `:` may be
// percent-encoded too (password%3Dx). A percent-encoded `&` (%26) ends an unquoted value like a plain one.
const NAME_SEP = /(?<![\p{L}\p{N}_.-])((?:[\p{L}\p{N}]|%5[Ff])(?:[\p{L}\p{N}_.-]|%5[Ff])*)\\?["']?\s*(?:=>|[:=]|%3[DdAa])\s*(\\?["']?)/gu
const ENCODED_AMP = /%26/i
// An authorization scheme other than Bearer/Basic has its own syntax after the word: the value runs to the end of the
// line under ANY credential-named header (x-auth-token: Token x, access_token: Token x, Digest username=...).
const OTHER_SCHEME = /^(?:Token|Digest|OAuth|Hawk|Negotiate|NTLM|AWS4-HMAC-SHA256|SSWS|ApiKey|Api-Key|Zoho-oauthtoken|Splunk)\s/i
const UNQUOTED = /[^\s"'&,;})]+/y
const SCHEME = /^(?:Bearer|Basic)\s+/i
const SCHEME_AT = /(?:Bearer|Basic)\s+/iy
// Index of the quote that closes a value opened by `q` (`"`, `'` or the JSON-escaped `\"`), or -1 when the line ends first.
// In the escaped form the inner document's own escapes are doubled: `\\\"` is an escaped quote INSIDE the value and `\\\\` an
// escaped backslash; only a bare `\"` closes.
function closingQuote(s: string, from: number, q: string): number {
  const escaped = q.length === 2
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1
    if (escaped) {
      if (s[i] !== '\\') continue
      if (s[i + 1] === '\\') { i += s[i + 2] === '\\' && s[i + 3] === q[1] ? 3 : 1; continue }   // \\\" inner quote, \\\\ inner backslash
      if (s[i + 1] === q[1]) return i
      i++; continue
    }
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
    if (c === '"' || (c === "'" && !/[\p{L}\p{N}]/u.test(s[i - 1] ?? ''))) quote = c   // an apostrophe inside a word (Bob's) opens no string
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1 }
  }
  return -1
}
const lineEnd = (s: string, from: number): number => { const nl = s.indexOf('\n', from); return nl >= 0 ? nl : s.length }
// A YAML-style block: the name ends its line, and the value is the run of lines below it indented deeper than the name
// (`credentials:\n  username: bob\n  value: x`). Ends before the first line indented no deeper (blank lines are inside).
function blockEnd(s: string, nameAt: number, from: number): number {
  const lineStart = s.lastIndexOf('\n', nameAt - 1) + 1
  const base = s.slice(lineStart, nameAt).search(/\S|$/)
  let end = from, at = s.lastIndexOf('\n', from - 1) + 1
  while (at < s.length) {
    const nl = s.indexOf('\n', at), stop = nl >= 0 ? nl : s.length
    const line = s.slice(at, stop), indent = line.search(/\S|$/)
    if (line.trim() !== '' && indent <= base) break
    if (line.trim() !== '') end = stop
    if (nl < 0) break
    at = nl + 1
  }
  return end
}
// The ranges [from, end) of assigned credential values in `s` (a kept scheme word is outside the range).
interface Hit { from: number; end: number }
function findAssigned(s: string): Hit[] {
  const hits: Hit[] = []
  NAME_SEP.lastIndex = 0
  for (let m = NAME_SEP.exec(s); m; m = NAME_SEP.exec(s)) {
    const name = m[1].replace(/%5[Ff]/g, '_')
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
      else if (start === from && s.slice(m.index! + m[1].length, from).includes('\n')) end = blockEnd(s, m.index!, from)
      else if (start === from && (lineValued(name) || OTHER_SCHEME.test(s.slice(from, from + 24)))) end = lineEnd(s, from)
      else {
        UNQUOTED.lastIndex = start; if (!UNQUOTED.exec(s)) continue; end = UNQUOTED.lastIndex
        const amp = s.slice(start, end).search(ENCODED_AMP); if (amp >= 0) end = start + amp
      }
    }
    const value = s.slice(from, end)
    const scheme = SCHEME.exec(value)?.[0] ?? ''
    const body = value.slice(scheme.length).replace(/\s+$/, '')
    if (body === '' || body === SECRET) continue
    if (!quote && NUMBER.test(body) && !numberIsSecret(name)) continue
    hits.push({ from: from + scheme.length, end: from + scheme.length + body.length })
    NAME_SEP.lastIndex = from + scheme.length + body.length
  }
  return hits
}
// Replaces each range by the marker; overlapping or touching ranges (the same value found through two decodings) merge.
function applyHits(s: string, hits: Hit[]): string {
  if (!hits.length) return s
  const sorted = [...hits].sort((a, b) => a.from - b.from)
  let out = '', last = 0
  for (const h of sorted) {
    if (h.from < last) { continue }
    out += s.slice(last, h.from) + SECRET
    last = h.end
  }
  return out + s.slice(last)
}
const redactAssigned = (s: string): string => applyHits(s, findAssigned(s))

// Every `"name": "..."` a string carries, whether or not the string parses as JSON as a whole: a fenced reply
// ("```json\n[...]\n```"), a reply with a preamble ("Here you go: [...]") or a reply cut short still names people.
const NAME_FIELD = /"name"\s*:\s*"((?:[^"\\]|\\.)+)"/g
// A "name" that is a placeholder or a role, not a person: replacing every "the" or "unknown" in a trace would wreck it.
const NOT_A_NAME = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'none', 'null', 'unknown', 'n/a', 'na', 'name', 'test', 'user', 'admin', 'person', 'company', 'contact', 'unnamed', 'anonymous', 'various', 'multiple', 'team', 'staff', 'founder', 'founders', 'ceo', 'cto', 'cfo', 'coo', 'owner', 'director', 'manager', 'partner', 'member', 'spokesperson', 'representative', 'undefined', 'string', 'tbd', 'tba'])
export const isPersonName = (n: string): boolean => n.length >= 3 && /\p{L}/u.test(n) && !NOT_A_NAME.has(n.toLowerCase())
function collectNames(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') {
    if (v.trim().startsWith('[') || v.trim().startsWith('{')) { try { collectNames(JSON.parse(v), out) } catch { /* not JSON as a whole */ } }
    if (v.includes('"name"')) for (const m of v.matchAll(NAME_FIELD)) { try { const n = (JSON.parse(`"${m[1]}"`) as string).trim(); if (isPersonName(n)) out.add(n) } catch { /* not a JSON string */ } }
    return
  }
  if (Array.isArray(v)) { for (const x of v) collectNames(x, out); return }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (k === 'name' && typeof x === 'string' && isPersonName(x.trim())) out.add(x.trim())
    else collectNames(x, out)
  }
}

const parseJson = (s: string): unknown => { const t = s.trim(); if (!t.startsWith('{') && !t.startsWith('[')) return undefined; try { return JSON.parse(s) as unknown } catch { return undefined } }

export function redactTrace(t: Trace, salt: Buffer = randomBytes(16)): Trace {
  const h = (s: string) => createHmac('sha256', salt).update(s).digest('hex')
  const names = new Set<string>()
  for (const s of t.spans) if (s.kind === 'model') collectNames(s.output, names)
  for (const l of t.output?.leads ?? []) if (isPersonName(l.name.trim())) names.add(l.name.trim())
  const nameList = [...names].sort((a, b) => b.length - a.length) // longest first: "Ada Lovelace" before "Ada"
  // Credentials: families, then assignments by name, then HTML attribute pairs, then the same inside percent-encoded
  // URL query values.
  const core = (x: string): string => {
    let r = x
    for (const [re, to] of FAMILIES) r = r.replace(re, to)
    return redactEncoded(redactHtmlAttributes(redactAssigned(r)))
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
  // Under a credential-named key the WHOLE value goes, whatever its type: a string, a number (`token: 112233`), an object
  // or array (`cookie: {name, value}`, `credentials: [...]`, `otp: [4, 9, 3]`), a Buffer's byte map (`{"0": 66, ...}`),
  // a Map or Date (which serialise as {} here and go too). Booleans and null carry no value and stay. Only a count-shaped
  // token/key name (max_tokens, tokens, num_keys) keeps its numbers and is descended into - with `secret` set, so every
  // string below it still goes. A key that is a URL or path (a page map keyed by URL whose query says `?key=london`) is
  // not a credential name for its subtree: its own text is redacted, its value is descended into normally.
  // `countTree`: below a count-shaped token/key name (`tokens: {...}`): a number there keeps only under a key that
  // itself names a count (input, output, total, max); `tokens: {refresh: 12345678}` goes.
  const deep = (v: unknown, secret: boolean, countTree: boolean): unknown =>
    typeof v === 'string' ? str(v, secret)
      : typeof v === 'number' ? (countTree ? SECRET : v)
        : Array.isArray(v) ? v.map(x => deep(x, secret, countTree))
          : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => {
            const cred = isCredentialKey(k) && !/[/?&=]/.test(k)
            if (cred && !isCountKey(k) && x !== null && typeof x !== 'boolean') return [text(k), SECRET]
            if (typeof x === 'number') return [text(k), !cred && countTree && !hasCountWord(k) ? SECRET : x]
            return [text(k), deep(x, secret || cred, countTree || cred)]
          }))
            : v
  // EVERY string of the trace goes through the pass - span errors (an inner call's error message can quote a URL, a
  // header or an address), names, the agent label, metadata - except the structural identifiers this module's own code
  // wrote (trace and span ids, kinds, the path), which are put back as they were.
  const all = deep(t, false, false) as Trace
  return { ...all, v: t.v, kind: t.kind, id: t.id, path: t.path, redacted: true, spans: all.spans.map((s, i) => ({ ...s, id: t.spans[i].id, kind: t.spans[i].kind })) }
}
