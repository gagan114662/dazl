// dazl Connect (#1037, #1122): reads the LinkedIn pages YOUR dazl workspace asks for, in this browser, with your own LinkedIn sign-in.
//
// It never reads, stores or sends a LinkedIn cookie: there is no "cookies" permission. dazl's server never makes a LinkedIn request.
//
// 1. dazl Settings ("Connect LinkedIn") sends {type: 'pair', code} from a dazl page (externally_connectable: dazl's own origins only).
// 2. The extension trades the one-time code for a device token at that same origin (/api/extension/linkedin) and keeps
//    {origin, token} in chrome.storage.local.
// 3. Every minute it asks that workspace (/api/tasks/next) for the next LinkedIn page to read. dazl's server decides the pace (the
//    workspace's reading hours, one page at a time, a 45-180 s pause between pages, a daily cap, a day's stop after any LinkedIn
//    security check or slow-down) and answers "wait" otherwise; this extension cannot read faster than dazl allows.
// 4. With a task it opens that one page in a background tab, reads it (content.js: scrolling only, no clicks), sends what it read
//    (/api/tasks/complete) and closes the tab. It never connects, messages, likes or follows anyone.
// 5. Disconnect in dazl revokes the token (the next call gets 401 and the extension forgets it); {type: 'forget'} also forgets it.

const STORE_KEY = 'dazl'
const POLL = 'dazl-poll'
const TAB_TIMEOUT_MS = 90_000
let busy = false

function dazlOrigins() {
  const m = chrome.runtime.getManifest().externally_connectable?.matches ?? []
  return m.map(p => { try { return new URL(p.replace(/\*$/, '')).origin } catch { return null } }).filter(Boolean)
}
async function stored() { return (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] ?? null }
async function forget() { await chrome.storage.local.remove(STORE_KEY) }
async function patch(p) { const s = await stored(); if (s) await chrome.storage.local.set({ [STORE_KEY]: { ...s, ...p } }) }

async function call(origin, token, path, body) {
  const res = await fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'omit', // never the user's dazl cookies: the bearer secret is the only credential
    cache: 'no-store',
  })
  let json = null
  try { json = await res.json() } catch { /* not JSON */ }
  return { status: res.status, json }
}

async function pair(origin, code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9._-]{10,200}$/.test(code)) return { ok: false, error: 'Bad pairing code' }
  const r = await call(origin, code, '/api/extension/linkedin', { action: 'pair' })
  if (r.status !== 200 || typeof r.json?.device_token !== 'string') return { ok: false, error: (r.json && r.json.error) || `dazl answered ${r.status}` }
  await chrome.storage.local.set({ [STORE_KEY]: { origin, token: r.json.device_token, name: null, paired_at: Date.now(), last: null } })
  chrome.alarms.create(POLL, { periodInMinutes: 1 })
  return { ok: true }
}

function waitForLoad(tabId) {
  return new Promise(resolve => {
    const done = ok => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); resolve(ok) }
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(true) }
    const t = setTimeout(() => done(false), 45_000)
    chrome.tabs.onUpdated.addListener(on)
  })
}
async function ask(tabId, kind) {
  const deadline = Date.now() + TAB_TIMEOUT_MS
  while (Date.now() < deadline) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'dazl-read', kind }); if (r) return r } catch { /* not loaded yet */ }
    await new Promise(r => setTimeout(r, 2000))
  }
  return { error: 'extract_failed' }
}

async function poll() {
  if (busy) return
  const s = await stored()
  if (!s) return
  busy = true
  let tabId = null
  try {
    const next = await call(s.origin, s.token, '/api/tasks/next')
    if (next.status === 401) { await forget(); return }
    if (next.status !== 200 || !next.json) return patch({ last: { state: 'error', status: next.status, at: Date.now() } })
    if (!next.json.task) return patch({ last: { state: 'waiting', reason: next.json.wait || 'unknown', at: Date.now() } })
    const { id, kind, url } = next.json.task
    const tab = await chrome.tabs.create({ url, active: false })
    tabId = tab.id
    await waitForLoad(tabId)
    const result = await ask(tabId, kind)
    await call(s.origin, s.token, '/api/tasks/complete', { id, ...result })
    await patch({ last: { state: 'read', kind, people: Array.isArray(result.people) ? result.people.length : (result.person ? 1 : 0), error: result.error || null, at: Date.now() } })
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {})
    busy = false
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(POLL, { periodInMinutes: 1 }))
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(POLL, { periodInMinutes: 1 }))
chrome.alarms.onAlarm.addListener(a => { if (a.name === POLL) poll().catch(() => { busy = false }) })

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
  return true
})

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'state') { void stored().then(s => reply(s ? { connected: true, origin: s.origin, last: s.last ?? null } : { connected: false })); return true }
  if (msg?.type === 'forget') { void forget().then(() => reply({ ok: true })); return true }
  return false
})
