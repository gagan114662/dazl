import { chromium } from 'playwright-core'
import fs from 'node:fs'
const [icon, out] = process.argv.slice(2)
const iconData = 'data:image/png;base64,' + fs.readFileSync(icon).toString('base64')
const b = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true })
const p = await b.newPage({ viewport: { width: 440, height: 280 } })
await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:440px;height:280px;overflow:hidden;background:#111}
.t{position:absolute;inset:0;padding:0 40px;display:flex;flex-direction:column;justify-content:center;color:#f4f4f1;font:16px/1.4 -apple-system,system-ui,sans-serif}
.t img{width:56px;height:56px;border-radius:12px;border:1px solid #333;margin-bottom:18px;display:block}
.n{font-size:30px;letter-spacing:-.02em;font-weight:650;line-height:1.1}.s{color:#bbb;margin-top:10px;font-size:16px;max-width:19em}
</style></head><body><div class="t"><img src="${iconData}"><div class="n">dazl Connect</div><div class="s">Your LinkedIn, read in your own browser, at a human pace.</div></div></body></html>`)
await p.waitForTimeout(200)
await p.screenshot({ path: out, type: 'jpeg', quality: 92 })
await b.close()
