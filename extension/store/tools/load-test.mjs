// Loads the unpacked extension in Chromium, pairs it to a local fake dazl server by writing storage, and runs one poll.
import { chromium } from 'playwright-core'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
const ext = process.argv[2]
const calls = []
let served = false
const srv = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    calls.push({ path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tasks/next') { const task = served ? null : { id: 't1', kind: 'company_people', url: 'https://www.linkedin.com/company/linkedin/people/' }; served = true; return res.end(JSON.stringify(task ? { task } : { wait: 'empty' })) }
    res.end(JSON.stringify({ ok: true }))
  })
}).listen(0)
const origin = `http://127.0.0.1:${srv.address().port}`
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dazl-ext-'))
const ctx = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROME_EXE, headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] })
let sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 20000 })
const id = new URL(sw.url()).host
const man = await sw.evaluate(() => chrome.runtime.getManifest())
console.log('extension id', id, 'version', man.version, 'permissions', JSON.stringify(man.permissions))
await sw.evaluate(async o => { await chrome.storage.local.set({ dazl: { origin: o, token: 'test-token', name: null, paired_at: Date.now(), last: null } }) }, origin)
const before = ctx.pages().length
await sw.evaluate(() => poll())
const st = await sw.evaluate(async () => (await chrome.storage.local.get('dazl')).dazl)
console.log('calls', JSON.stringify(calls.map(c => ({ path: c.path, auth: c.auth, body: c.body && { id: c.body.id, error: c.body.error, people: Array.isArray(c.body.people) ? c.body.people.length : undefined } }))))
console.log('last', JSON.stringify(st.last))
await new Promise(r => setTimeout(r, 1000))
console.log('tabs before', before, 'after', ctx.pages().length)
// popup renders
const p = await ctx.newPage(); await p.goto(`chrome-extension://${id}/popup.html`); await p.waitForTimeout(500)
console.log('popup:', await p.locator('#state').innerText())
await ctx.close(); srv.close()
