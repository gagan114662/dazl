// Settings > Team and /app/join on the production build, against the REAL API (nothing stubbed): an owner invites a
// teammate, the teammate signs up and opens the one-time link, both see the workspace as their role allows, the owner
// removes the teammate and the teammate is back in their own workspace.
// NOT part of `npm test`. Run:  cd web && npm run build && node test/ui/team.ui.mjs   (SHOTS=<dir> saves desktop and
// 390px screenshots). Throwaway database, server under test/helpers/net-fence.ts (no outbound call), no email sent.
// It proves:
//   1. the owner sees "You are owner", invites by email and role, and gets the link once, with the token after #t=;
//   2. the teammate opens the link signed in: "You are in", then Settings > Team says operator and offers the switcher;
//   3. the teammate (operator) gets no invite form and no Remove buttons;
//   4. the owner sees both members and removes the teammate; the teammate's next load is their own workspace again;
//   5. a replayed link says it expired or was used; /app/join without a link says to open the emailed one;
//   6. no horizontal scroll at 390px on any of these screens.
// Exit 1 on a failed expectation. Missing playwright or build: NOT RUN, exit 2 (SMOKE_ALLOW_SKIP=1 makes it exit 0).
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadPlaywright, newContext, startServer } from '../smoke/harness.mjs'
const { chromium } = loadPlaywright()

const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const srv = await startServer()
const { base } = srv
let browser
const fits = async page => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal scroll on ${page.url()}`)
const team = page => page.locator('.card', { has: page.locator('h2', { hasText: 'Team' }) })
async function shot(page, name) {
  for (const [label, size] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(150)
    await fits(page)
    // the Team card when the page has one (Settings), else the page (/app/join)
    const card = team(page)
    const target = (await card.count()) ? card.first() : page
    if (SHOTS) await target.screenshot({ path: path.join(SHOTS, `${name}-${label}.png`) })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}
try {
  browser = await chromium.launch()
  // 1. the owner (the harness's seeded account) invites a teammate
  const ownerCtx = await newContext(browser, srv)
  const owner = await ownerCtx.newPage()
  await owner.goto(`${base}/app/settings#team`, { waitUntil: 'networkidle' })
  await team(owner).getByText('You are owner').waitFor()
  await team(owner).getByPlaceholder('teammate@company.com').fill('mate@example.test')
  await team(owner).locator('select').last().selectOption('operator')
  await team(owner).getByRole('button', { name: 'Invite' }).click()
  const link = (await team(owner).locator('code').textContent({ timeout: 10000 }))?.trim() ?? ''
  assert.match(link, new RegExp(`^${base.replace(/[.]/g, '\\.')}/app/join#t=[a-f0-9]{64}$`))
  await team(owner).getByText('mate@example.test (operator, pending)').waitFor()
  await shot(owner, 'team-owner-invited')

  // 2. the teammate signs up (a fresh account, its own workspace) and opens the link
  const mateCtx = await browser.newContext()
  await mateCtx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  const mate = await mateCtx.newPage()
  await mate.goto(`${base}/sign-up`, { waitUntil: 'networkidle' })
  const signup = await mate.evaluate(async () => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'mate@example.test', password: 'a long password 42', name: 'Mate', business_name: 'Mate Co' }) })).status)
  assert.equal(signup, 200)
  await mate.goto(link, { waitUntil: 'networkidle' })
  await mate.getByText('Confirm your email').waitFor()
  // Signup is unverified. Obtain its own fixture mail token from this throwaway
  // server's local outbox, then exercise the real verification endpoint before join.
  const fixtureDb = new Database(srv.dbPath)
  const mail = fixtureDb.prepare('SELECT body FROM system_mail_outbox WHERE to_email = ? ORDER BY rowid DESC').get('mate@example.test')
  fixtureDb.close()
  const verification = /\/verify#t=([a-f0-9]{64})/.exec(mail?.body ?? '')?.[1]
  assert.ok(verification, 'signup fixture has its own verification link')
  const verified = await mate.evaluate(async token => (await fetch('/api/auth/verify', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})})).status, verification)
  assert.equal(verified,200)
  await mate.goto(`${base}/app/settings`, {waitUntil:'networkidle'})
  await mate.goto(link, {waitUntil:'networkidle'})
  await mate.getByText('You are in.').waitFor()
  assert.equal(new URL(mate.url()).hash, '', 'the token is cleared from the address bar')
  await shot(mate, 'join-accepted')
  await mate.goto(`${base}/app/settings#team`, { waitUntil: 'networkidle' })
  await team(mate).getByText('You are operator').waitFor()
  assert.equal(await team(mate).getByPlaceholder('teammate@company.com').count(), 0, 'an operator gets no invite form')
  assert.equal(await team(mate).getByRole('button', { name: 'Remove' }).count(), 0, 'an operator gets no Remove')
  const options = await team(mate).locator('select').first().locator('option').allTextContents()
  assert.deepEqual(options, ['Your workspace (owner)', 'Workspace (operator)'], 'the switcher lists both workspaces, own first')
  await shot(mate, 'team-member-operator')

  // 4. the owner sees both members and removes the teammate
  await owner.reload({ waitUntil: 'networkidle' })
  await team(owner).getByText('mate@example.test').first().waitFor()
  await shot(owner, 'team-owner-members')
  await team(owner).getByRole('button', { name: 'Remove' }).click()
  await owner.waitForTimeout(500)
  assert.equal(await team(owner).getByText('mate@example.test').count(), 0)
  // still signed in: the app shell loads (no detour to sign-in); the first request meant for the old workspace is refused,
  // the next ones are the teammate's own workspace
  await mate.reload({ waitUntil: 'networkidle' })
  assert.equal(new URL(mate.url()).pathname, '/app/settings', 'a removed member is not sent to sign-in')
  await mate.reload({ waitUntil: 'networkidle' })
  await team(mate).getByText('You are owner').waitFor()
  await shot(mate, 'team-after-removal')

  // 5. a replayed link, and /app/join with no link
  await mate.goto(link, { waitUntil: 'networkidle' })
  await mate.getByText('This invitation link has expired, was already used, or was withdrawn.').waitFor()
  await shot(mate, 'join-used-link')
  await owner.goto(`${base}/app/join`, { waitUntil: 'networkidle' })
  await owner.getByText('Open the invitation link you were sent').waitFor()
  await shot(owner, 'join-no-link')
  console.log(`ok   Team and join on the production build: invite, join, roles, removal, replay${SHOTS ? `; screenshots in ${SHOTS}` : ''}`)
} catch (e) {
  console.log(`FAIL ${e.message}\n${srv.log().slice(-2000)}`)
  process.exitCode = 1
} finally {
  await browser?.close()
  srv.stop()
}
