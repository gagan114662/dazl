// dazl LinkedIn Reader (#1122). Every minute it asks the dazl workspace it is set up for whether there is a LinkedIn page to read.
// dazl's server decides the pace (09:00-17:00 in the workspace's time zone, one page at a time, a 45-180 s pause between pages,
// at most 40 pages a day) and answers "wait" otherwise; this extension cannot read faster than dazl allows. When there is a task it
// opens that one page in a background tab of THIS browser (the user's own LinkedIn sign-in), reads it (content.js: scrolling only,
// no clicks), sends what it read to dazl, and closes the tab. It never connects, messages, likes or follows anyone.
const POLL = 'dazl-poll'
const TAB_TIMEOUT_MS = 90_000
let busy = false

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(POLL, { periodInMinutes: 1 }))
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(POLL, { periodInMinutes: 1 }))
chrome.alarms.onAlarm.addListener(a => { if (a.name === POLL) poll().catch(() => { busy = false }) })
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage())

const settings = () => chrome.storage.local.get({ origin: 'https://dazl.ai', token: '', paused: false })
const status = s => chrome.storage.local.set({ status: { ...s, at: Date.now() } })

async function api(origin, token, path, body) {
  const r = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
  if (r.status === 401) { await status({ state: 'token_rejected' }); return null }
  return r.json().catch(() => null)
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
  // The content script loads with the page; retry briefly until it answers.
  const deadline = Date.now() + TAB_TIMEOUT_MS
  while (Date.now() < deadline) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'dazl-read', kind }); if (r) return r } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  return { error: 'extract_failed' }
}

async function poll() {
  if (busy) return
  const s = await settings()
  if (!s.token) return status({ state: 'no_token' })
  if (s.paused) return status({ state: 'paused' })
  busy = true
  let tabId = null
  try {
    const next = await api(s.origin, s.token, '/api/tasks/next')
    if (!next) return
    if (!next.task) return status({ state: 'waiting', reason: next.wait || 'unknown' })
    const { id, kind, url } = next.task
    const tab = await chrome.tabs.create({ url, active: false })
    tabId = tab.id
    await waitForLoad(tabId)
    const result = await ask(tabId, kind)
    await api(s.origin, s.token, '/api/tasks/complete', { id, ...result })
    await status({ state: 'read', kind, people: Array.isArray(result.people) ? result.people.length : (result.person ? 1 : 0), error: result.error || null })
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {})
    busy = false
  }
}
