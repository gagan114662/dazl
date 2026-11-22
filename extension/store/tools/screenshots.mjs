// Captures the real popup in three states from the packaged build, then composes 1280x800 store screenshots and a 440x280 tile.
import { chromium } from 'playwright-core'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'
const [ext, out, icon] = process.argv.slice(2)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dazl-shots-'))
const ctx = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROME_EXE, headless: true, deviceScaleFactor: 2, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] })
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 20000 })
const id = new URL(sw.url()).host
const at = new Date(); at.setHours(10, 42, 0, 0)
const states = {
  'not-connected': null,
  'connected-read': { origin: 'https://dazl.ai', token: 'x', name: null, paired_at: +at, last: { state: 'read', kind: 'company_people', people: 14, error: null, at: +at } },
  'connected-pacing': { origin: 'https://dazl.ai', token: 'x', name: null, paired_at: +at, last: { state: 'waiting', reason: 'pause_between_tasks', at: +at } },
}
const data = {}
for (const [name, st] of Object.entries(states)) {
  await sw.evaluate(async s => { if (s) await chrome.storage.local.set({ dazl: s }); else await chrome.storage.local.remove('dazl') }, st)
  const p = await ctx.newPage(); await p.setViewportSize({ width: 288, height: 220 })
  await p.goto(`chrome-extension://${id}/popup.html`); await p.waitForTimeout(400)
  const h = await p.evaluate(() => document.documentElement.scrollHeight)
  await p.setViewportSize({ width: 288, height: h })
  const buf = await p.screenshot(); fs.writeFileSync(path.join(out, `popup-${name}.png`), buf)
  data[name] = 'data:image/png;base64,' + buf.toString('base64'); await p.close()
}
const iconData = 'data:image/png;base64,' + fs.readFileSync(icon).toString('base64')
const frame = (title, sub, img, points) => `<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box}body{margin:0;width:1280px;height:800px;background:#f4f4f4;color:#111;font:18px/1.5 -apple-system,system-ui,sans-serif;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);align-items:center}
.l{padding:0 40px 0 88px}.brand{display:flex;align-items:center;gap:12px;font-weight:600;font-size:20px;margin-bottom:44px}.brand img{width:40px;height:40px;border-radius:9px}
h1{font-size:46px;line-height:1.12;letter-spacing:-.02em;margin:0 0 20px;font-weight:650;text-wrap:balance}p{margin:0 0 26px;color:#444;font-size:21px;max-width:30em}
ul{list-style:none;padding:0;margin:0;display:grid;gap:10px;font-size:18px}li{display:flex;gap:10px;align-items:baseline}li:before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:#111;transform:translateY(-2px)}
.r{display:flex;justify-content:center;padding-right:72px}.win{background:#fff;border:1px solid #d9d9d9;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.14);overflow:hidden}
.bar{height:38px;background:#ececec;border-bottom:1px solid #d9d9d9;display:flex;align-items:center;gap:7px;padding:0 14px}.bar i{width:11px;height:11px;border-radius:50%;background:#c9c9c9}
.win img{display:block;width:432px}</style>
<div class=l><div class=brand><img src="${iconData}">dazl Connect</div><h1>${title}</h1><p>${sub}</p><ul>${points.map(x => `<li>${x}</li>`).join('')}</ul></div>
<div class=r><div class=win><div class=bar><i></i><i></i><i></i></div><img src="${img}"></div></div>`
const frames = [
  ['1-connect', 'Connect LinkedIn to dazl in one click', 'Install, then click Connect LinkedIn in dazl Settings. No password and no cookie is ever copied.', data['not-connected'], ['Uses the LinkedIn account already signed in to this browser', 'Pairs only with your own dazl workspace']],
  ['2-reads-in-your-browser', 'Reads only the pages your workspace asks for', 'dazl Connect opens one LinkedIn page in a background tab, reads the names and job titles shown, and closes the tab.', data['connected-read'], ['Company People pages, profiles and post comments', 'Never connects, messages, likes, follows or posts']],
  ['3-slow-pace', 'A slow pace that dazl sets, and you can pause', 'One page at a time, a pause between pages, a daily cap, and a full day off whenever LinkedIn asks to slow down.', data['connected-pacing'], ['Reads only during your working hours', 'Pause in dazl Settings or forget this browser at any time']],
]
const pg = await ctx.newPage()
await pg.setViewportSize({ width: 1280, height: 800 })
for (const [name, t, s, img, pts] of frames) { await pg.setContent(frame(t, s, img, pts)); await pg.waitForTimeout(200); await pg.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 92, scale: 'css' }) }
await pg.setViewportSize({ width: 440, height: 280 })
await pg.setContent(`<!doctype html><meta charset=utf-8><style>body{margin:0;width:440px;height:280px;background:#111;color:#f4f4f1;font:16px/1.4 -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 40px}img{width:56px;height:56px;border-radius:12px;border:1px solid #333;margin-bottom:18px}b{font-size:30px;letter-spacing:-.02em;font-weight:650}span{color:#bbb;margin-top:6px;font-size:16px}</style><img src="${iconData}"><b>dazl Connect</b><span>Your LinkedIn, read in your own browser, at a human pace.</span>`)
await pg.screenshot({ path: path.join(out, 'promo-tile-440x280.jpg'), type: 'jpeg', quality: 92, scale: 'css' })
await ctx.close()
