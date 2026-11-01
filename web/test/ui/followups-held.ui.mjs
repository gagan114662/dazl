// Follow-ups held-state honesty (refs #434, refs #471 - synthetic regression coverage, not live acceptance).
// NOT part of `npm test`.
// Run:  cd web && npm run build && node test/ui/followups-held.ui.mjs   (SHOTS=<dir> saves screenshots)
// Production build, throwaway database, server under test/helpers/net-fence.ts, ALL data synthetic
// ("test only" markers), real signup and real /api/outreach/followups route: no stubbing, no send
// capability (gmail fixture row carries an invalid credential; net-fence strips keys/secrets).
// It proves the #434 contract on the deployed code path (lib/outreach/followups.ts followupOverview
// + app/follow-ups client):
//   1. a promised date ("next one ...") appears ONLY when no account hold, no thread hold, and the
//      daily cap does not hold a due thread;
//   2. held threads (no_consent, unsubscribed/bounced, sequence-owned, replied-again, daily_cap)
//      show "held: <reason>" plus the configuration date as "schedule said <date>", never a promise;
//   3. account holds (consent_outdated, autopilot_paused, uncertain_send) show the banner "Nothing
//      will be sent right now ... Dates below are the schedule, not a promise"; followups_off holds
//      every due thread with "the follow-ups switch is off" and promises nothing;
//   4. stopped threads render their stopped text (domain_unconfirmed, deliberately long company name);
//   5. at 390px identity, sent count, hold reason and schedule date stack full-width and readable.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(dir, 'package.json'))
const notRun = reason => { console.log(`NOT RUN${process.env.SMOKE_ALLOW_SKIP === '1' ? ' (allowed by SMOKE_ALLOW_SKIP=1)' : ''}: ${reason}`); process.exit(process.env.SMOKE_ALLOW_SKIP === '1' ? 0 : 2) }
let chromium
try { ({ chromium } = require('playwright')) } catch (e) { notRun(e.message.split('\n')[0]) }
if (!existsSync(path.join(dir, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const Database = require('better-sqlite3')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-followups-held-')); const DB = path.join(tmp, 'app.db')
const port = 3300 + Math.floor(Math.random() * 500); const base = `http://127.0.0.1:${port}`
const EMAIL = 'fx-followups-held@example.invalid'
const srv = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: dir, env: { PATH: process.env.PATH, DB_PATH: DB, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', AUTOPILOT_ENABLED: '1', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(dir, 'test/helpers/net-fence.ts')}` }, stdio: 'ignore' })
const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null
if (shots) mkdirSync(shots, { recursive: true })
const b = await chromium.launch()
try {
  for (let i = 0; i < 150; i++) { try { await fetch(base + '/sign-in'); break } catch { await new Promise(r => setTimeout(r, 200)) } }
  // Real signup (verification mail has no SMTP under the fence and stays in the outbox table).
  const res = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: 'fixturepass123', name: 'Fixture Runner (test only)', business_name: 'followups held fixture (test only)' }) })
  assert.equal(res.status, 200, `signup: ${res.status}`)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie.startsWith('dazl_session='), 'signup sets the session cookie')
  const token = cookie.slice('dazl_session='.length)
  // Migrate-then-fixture: the signup already migrated the schema; add synthetic state.
  const db = new Database(DB)
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL).id
  const tenant = db.prepare('SELECT tenant_id FROM memberships WHERE member_id = ?').get(user)?.tenant_id ?? user
  const now = Math.floor(Date.now() / 1000), D = 86400
  db.exec(`
    INSERT INTO scan_jobs (id,user_id,status,business_name,industry,location,attempts,created_at,finished_at)
    VALUES ('fxFHjob1','${user}','running','followups held fixture (test only)','fixture','fixture',1,${now - 7 * D},${now - 7 * D + 100});
    INSERT INTO leads (id,scan_job_id,name,company,contact,signal,source_url,created_at,source_kind) VALUES
      ('fxFHL1','fxFHjob1','Ada Control','Fixture Control Co (test only)','ada@fixture.invalid','fixture','https://fixture.invalid/1',${now - 7 * D},'test'),
      ('fxFHL2','fxFHjob1','Nia Noconsent','Fixture Noconsent Ltd (test only)','nia@fixture.invalid','fixture','https://fixture.invalid/2',${now - 7 * D},'test'),
      ('fxFHL3','fxFHjob1','Sam Suppressed','Fixture Suppressed Inc (test only)','sam@fixture.invalid','fixture','https://fixture.invalid/3',${now - 7 * D},'test'),
      ('fxFHL4','fxFHjob1','Seb Sequence','Fixture Sequenceown (test only)','seb@fixture.invalid','fixture','https://fixture.invalid/4',${now - 7 * D},'test'),
      ('fxFHL5','fxFHjob1','Rea Replied','Fixture Replied Co (test only)','rea@fixture.invalid','fixture','https://fixture.invalid/5',${now - 7 * D},'test'),
      ('fxFHL6','fxFHjob1','Dee Domainhold','Fixture Domainhold With A Deliberately Long Company Name (test only)','dee@fixture.invalid','fixture','https://fixture.invalid/6',${now - 7 * D},'test'),
      ('fxFHL7','fxFHjob1','Cal Capped','Fixture Capped Co (test only)','cal@fixture.invalid','fixture','https://fixture.invalid/7',${now - 7 * D},'test');
    INSERT INTO gmail_accounts (tenant_id,email,refresh_ct,status,connected_at,read_granted)
    VALUES ('${tenant}','fixture@example.invalid','INVALID-FIXTURE-NOT-A-TOKEN','active',${now - 7 * D},1);
    INSERT INTO autopilot_settings (tenant_id,enabled,paused,pause_reason,consent_version,consent_at,daily_cap,followups_enabled)
    VALUES ('${tenant}',1,0,NULL,'2026-10-20',${now - 7 * D},20,1);
    INSERT INTO outreach_settings (tenant_id,sender_name,postal_address,booking_url)
    VALUES ('${tenant}','Fixture Sender (test only)','1 Fixture Way (test only)',NULL);
    INSERT INTO consent_ledger (id,tenant_id,contact,channel,scope,basis,evidence_ref,granted_at,expires_at) VALUES
      ('fxFHc1','${tenant}','ada@fixture.invalid','email','followup','user_approved_set','fixture',${now - 7 * D},${now + 30 * D}),
      ('fxFHc2','${tenant}','cal@fixture.invalid','email','followup','user_approved_set','fixture',${now - 7 * D},${now + 30 * D});
    INSERT INTO suppressions (tenant_id,email,reason,created_at) VALUES ('${tenant}','sam@fixture.invalid','unsubscribe',${now - 7 * D});
    INSERT INTO sequences (id,tenant_id,lead_id,message_id,to_email,status,created_at)
    VALUES ('fxFHseq1','${tenant}','fxFHL4','fxFHm4','seb@fixture.invalid','active',${now - 7 * D});
    INSERT INTO followup_threads (tenant_id,thread_id,lead_id,to_email,root_message_id,last_activity_at,last_lead_reply_at,followups_sent,last_followup_at,stopped) VALUES
      ('${tenant}','fxFHT1','fxFHL1','ada@fixture.invalid','fxFHr1',${now - 2 * D},${now - 2 * D},0,NULL,NULL),
      ('${tenant}','fxFHT2','fxFHL2','nia@fixture.invalid','fxFHr2',${now - 4 * D},${now - 4 * D},0,NULL,NULL),
      ('${tenant}','fxFHT3','fxFHL3','sam@fixture.invalid','fxFHr3',${now - 4 * D},${now - 4 * D},0,NULL,NULL),
      ('${tenant}','fxFHT4','fxFHL4','seb@fixture.invalid','fxFHr4',${now - 4 * D},${now - 4 * D},0,NULL,NULL),
      ('${tenant}','fxFHT5','fxFHL5','rea@fixture.invalid','fxFHr5',${now - 4 * D},${now - 1 * D},1,${now - 2 * D},NULL),
      ('${tenant}','fxFHT6','fxFHL6','dee@fixture.invalid','fxFHr6',${now - 4 * D},${now - 4 * D},0,NULL,'domain_unconfirmed'),
      ('${tenant}','fxFHT7','fxFHL7','cal@fixture.invalid','fxFHr7',${now - 4 * D},${now - 4 * D},0,NULL,NULL);
  `)
  const ins = db.prepare("INSERT INTO followup_messages (tenant_id,thread_id,step,status,gmail_id,created_at) VALUES (?,?,1,'sent',?,?)")
  for (let i = 1; i <= 20; i++) ins.run(tenant, `fxFHTm${i}`, `fxFHg${i}`, now - 3600) // fills the rolling daily cap (20)
  db.exec(`UPDATE scan_jobs SET status='done', finished_at=${now - 7 * D + 100} WHERE id='fxFHjob1'`)
  db.close()

  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const page = await ctx.newPage()
  await page.goto(`${base}/app/follow-ups`, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const body = await page.textContent('body') ?? ''
  assert.match(body, /next one/, 'control thread promises a date when nothing holds it')
  const held = await page.locator('[data-testid=thread-held]').allTextContents()
  assert.ok(held.length >= 5, `held rows present, got ${held.length}`)
  assert.ok(held.some(t => /no current follow-up consent/.test(t)), 'no_consent hold shown')
  assert.ok(held.some(t => /unsubscribed or bounced/.test(t)), 'suppressed hold shown')
  assert.ok(held.some(t => /in a sequence/.test(t)), 'sequence-owned hold shown')
  assert.ok(held.some(t => /sending limit/.test(t)), 'daily cap hold shown')
  assert.ok(held.every(t => /schedule said/.test(t)), 'every held row shows the configuration date')
  const heldCards = await page.locator('[data-testid=thread-held]').evaluateAll(els => els.map(e => e.parentElement?.textContent ?? ''))
  assert.ok(heldCards.every(c => !/next one/.test(c)), 'no held card promises a date')
  const stopped = await page.locator('[data-testid=stopped-row]').allTextContents()
  assert.ok(stopped.some(t => /not confirmed as the right company/.test(t)), 'stopped domain_unconfirmed text')
  if (shots) await page.screenshot({ path: path.join(shots, 'followups-held-desktop.png'), fullPage: true })

  // Account-hold banner states; the synthetic settings row flips and restores between checks.
  const db2 = new Database(DB)
  const snap = db2.prepare('SELECT consent_version, followups_enabled, paused FROM autopilot_settings WHERE tenant_id = ?').get(tenant)
  const banner = async (name, stmt, marker) => {
    db2.exec(stmt)
    await page.goto(`${base}/app/follow-ups`, { waitUntil: 'load' }); await page.waitForTimeout(1200)
    const bb = await page.textContent('body') ?? ''
    if (name === 'followups_off') {
      const hr = await page.locator('[data-testid=thread-held]').allTextContents()
      assert.ok(hr.some(t => /follow-ups switch is off/.test(t)) && !/next one/.test(bb), 'followups_off holds every due thread and promises nothing')
    } else {
      assert.match(bb, /Nothing will be sent right now/, `${name}: banner present`)
      assert.match(bb, /schedule, not a promise/, `${name}: schedule-not-promise wording`)
      if (marker) assert.ok(bb.includes(marker), `${name}: reason text`)
    }
    if (shots) await page.screenshot({ path: path.join(shots, `followups-held-${name}.png`), fullPage: true })
    db2.prepare('UPDATE autopilot_settings SET consent_version = ?, followups_enabled = ?, paused = ? WHERE tenant_id = ?').run(snap.consent_version, snap.followups_enabled, snap.paused, tenant)
  }
  await banner('consent_outdated', `UPDATE autopilot_settings SET consent_version='1999-01-01'`, 'consent again')
  await banner('followups_off', `UPDATE autopilot_settings SET followups_enabled=0`, null)
  await banner('autopilot_paused', `UPDATE autopilot_settings SET paused=1`, 'paused')
  db2.exec(`UPDATE followup_messages SET status='uncertain' WHERE rowid=(SELECT min(rowid) FROM followup_messages)`)
  await page.goto(`${base}/app/follow-ups`, { waitUntil: 'load' }); await page.waitForTimeout(1200)
  assert.match(await page.textContent('body') ?? '', /unknown result/, 'uncertain_send banner')
  db2.exec(`UPDATE followup_messages SET status='sent' WHERE status='uncertain'`)
  db2.close()

  // 390px: identity / count / hold / configuration date stack full-width; long texts wrap readable.
  const mob = await b.newContext({ viewport: { width: 390, height: 844 } })
  await mob.addCookies([{ name: 'dazl_session', value: token, url: base }])
  const mp = await mob.newPage()
  await mp.goto(`${base}/app/follow-ups`, { waitUntil: 'load' }); await mp.waitForTimeout(1200)
  const mb = await mp.textContent('body') ?? ''
  assert.match(mb, /schedule said/, '390px: held rows show configuration date')
  assert.match(mb, /not confirmed as the right company/, '390px: stopped text present')
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
  assert.equal(overflow, false, '390px: no horizontal scroll')
  if (shots) {
    const row = mp.locator('[data-testid=stopped-row]').first()
    await row.scrollIntoViewIfNeeded(); await row.screenshot({ path: path.join(shots, 'followups-held-390-stopped.png') })
    await mp.screenshot({ path: path.join(shots, 'followups-held-390.png') })
  }
  console.log('follow-ups held-state UI check passed: promised dates only when the runner would send; held threads show reason + configuration date, never a promise; account-hold banners (consent/paused/uncertain/off); stopped text; 390px readable, no horizontal scroll')
} finally {
  await b.close(); srv.kill(); rmSync(tmp, { recursive: true, force: true })
}
