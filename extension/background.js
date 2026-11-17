// dazl Connect (#1037): connects the LinkedIn account signed in to THIS browser to the user's dazl workspace.
//
// Single purpose. It reads exactly two cookies, li_at and JSESSIONID, of linkedin.com (nothing else: no history, no tabs, no page content,
// no other site), and sends them only to the dazl site that paired it, over HTTPS.
//
// 1. dazl Settings ("Connect LinkedIn") sends {type: 'pair', code} from a dazl page (externally_connectable: dazl's own origins only).
// 2. The extension trades the one-time code for a device token at that same origin (/api/extension/linkedin) and keeps
//    {origin, token} in chrome.storage.local.
// 3. It sends the two cookies; dazl stores them encrypted for that workspace and answers with the account's name.
// 4. When LinkedIn rotates either cookie (cookies.onChanged), it sends them again, so the connection does not silently die.
// 5. Disconnect in dazl revokes the token (the next sync gets 401 and the extension forgets it); {type: 'forget'} also forgets it.

const LINKEDIN = 'https://www.linkedin.com'
const COOKIES = ['li_at', 'JSESSIONID']
const STORE_KEY = 'dazl'

// The dazl origins this build accepts: exactly the pages allowed to message it (manifest externally_connectable).
function dazlOrigins() {
  const m = chrome.runtime.getManifest().externally_connectable?.matches ?? []
  return m.map(p => { try { return new URL(p.replace(/\*$/, '')).origin } catch { return null } }).filter(Boolean)
}

async function readSession() {
  const out = {}
  for (const name of COOKIES) {
    const c = await chrome.cookies.get({ url: LINKEDIN, name })
    if (!c || !c.value) return null
    out[name] = c.value
  }
  return { li_at: out.li_at, jsessionid: out.JSESSIONID }
}

async function call(origin, token, body) {
  const res = await fetch(`${origin}/api/extension/linkedin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    credentials: 'omit', // never the user's dazl cookies: the bearer secret is the only credential
  })
  let json = null
  try { json = await res.json() } catch { /* not JSON */ }
  return { status: res.status, json }
}

async function stored() { return (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] ?? null }
async function forget() { await chrome.storage.local.remove(STORE_KEY) }

// Sends the current session to the paired workspace. check: ask dazl to name the account.
async function sync(check) {
  const s = await stored()
  if (!s) return { ok: false, error: 'Not connected to dazl.' }
  const session = await readSession()
  if (!session) return { ok: false, error: 'Sign in to LinkedIn in this browser first. dazl connects as soon as you do.' }
  const r = await call(s.origin, s.token, { action: 'session', ...session, check: !!check })
  if (r.status === 401) { await forget(); return { ok: false, error: 'This browser is no longer connected to dazl. Click Connect LinkedIn in dazl Settings.' } }
  if (r.status !== 200) return { ok: false, error: (r.json && r.json.error) || `dazl answered ${r.status}` }
  // Only when this browser is still paired with the same token: a Disconnect / forget (or a new pairing) while this request was in flight wins.
  const now = await stored()
  if (now && now.token === s.token) await chrome.storage.local.set({ [STORE_KEY]: { ...now, name: r.json?.name ?? now.name ?? null, synced_at: Date.now() } })
  return { ok: true, name: r.json?.name ?? null }
}

async function pair(origin, code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9._-]{10,200}$/.test(code)) return { ok: false, error: 'Bad pairing code' }
  const r = await call(origin, code, { action: 'pair' })
  if (r.status !== 200 || typeof r.json?.device_token !== 'string') return { ok: false, error: (r.json && r.json.error) || `dazl answered ${r.status}` }
  await chrome.storage.local.set({ [STORE_KEY]: { origin, token: r.json.device_token, name: null, synced_at: null } })
  return sync(true)
}

chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : null)
  if (!origin || !dazlOrigins().includes(origin)) { reply({ ok: false, error: 'not a dazl page' }); return false }
  const run = async () => {
    if (msg?.type === 'ping') return { ok: true, version: chrome.runtime.getManifest().version }
    if (msg?.type === 'pair') return pair(origin, msg.code)
    if (msg?.type === 'forget') { await forget(); return { ok: true } }
    return { ok: false, error: 'unknown request' }
  }
  run().then(reply, e => reply({ ok: false, error: String(e && e.message || e).slice(0, 200) }))
  return true // the reply is sent asynchronously
})

// LinkedIn rotates JSESSIONID (and sometimes li_at): send the new pair, debounced, only when this browser is paired.
let timer = null
chrome.cookies.onChanged.addListener(({ removed, cookie }) => {
  if (removed || !COOKIES.includes(cookie.name) || !/(^|\.)linkedin\.com$/.test(cookie.domain.replace(/^\./, ''))) return
  clearTimeout(timer)
  timer = setTimeout(() => { void stored().then(s => { if (s) void sync(false) }) }, 3000)
})

// The popup asks for the current state.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'state') { void stored().then(s => reply(s ? { connected: true, origin: s.origin, name: s.name, synced_at: s.synced_at } : { connected: false })); return true }
  if (msg?.type === 'sync') { void sync(true).then(reply); return true }
  if (msg?.type === 'forget') { void forget().then(() => reply({ ok: true })); return true }
  return false
})
