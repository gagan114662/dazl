// Staging seed (docs/STAGING.md): one demo account on the staging database, so the whole journey is clickable. It has:
//   - a reviewed buyer profile;
//   - two past scans with verified leads (fictional companies on the reserved .test domain);
//   - a sender identity;
//   - a stub Gmail connection (lib/staging.ts: nothing can be sent).
// Refuses to run unless DAZL_ENV=staging. Writes only to DB_PATH (SQLite), the staging store. Idempotent: an existing
// demo account is left as it is, so a re-run after a deploy changes nothing.
//   DAZL_ENV=staging DB_PATH=/var/lib/dazl-staging/app.db DAZL_MASTER_KEY=... STAGING_DEMO_PASSWORD=... \
//     node --experimental-strip-types scripts/staging-seed.mts
// The password comes from the environment only, never from this file.
import Database from 'better-sqlite3'
import { randomBytes, scryptSync } from 'node:crypto'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createQueryJob, finishJob, type LeadRow } from '../lib/scan/store-db.ts'
import { startOAuth } from '../lib/gmail/oauth.ts'
import { isStaging } from '../lib/staging.ts'

export const DEMO_EMAIL = 'demo@staging.dazl.test'
const DAY = 86_400

export async function seedStaging(raw: Database.Database, password: string, now = Math.floor(Date.now() / 1000)): Promise<{ created: boolean; tenant: string }> {
  if (!isStaging()) throw new Error('staging-seed: refusing to run without DAZL_ENV=staging')
  if (password.length < 12) throw new Error('staging-seed: STAGING_DEMO_PASSWORD must be at least 12 characters')
  migrateAllSqlite(raw)
  const existing = raw.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_EMAIL) as { id: string } | undefined
  if (existing) return { created: false, tenant: existing.id }

  const id = randomBytes(16).toString('hex'), salt = randomBytes(16).toString('hex')
  raw.prepare('INSERT INTO users (id, email, name, business_name, sells, website, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, DEMO_EMAIL, 'Demo Owner', 'Harbour Dental Supply (demo)', 'Dental chairs, sterilisers and practice equipment', 'https://harbour-dental.example.test', scryptSync(password, salt, 64).toString('hex'), salt)
  const icp = {
    summary: 'Independent dental practices in Ohio and Texas that are opening a location or expanding their team',
    who: ['Practice owner', 'Practice manager'], industries: ['Dental practices'], sizes: ['1-50 employees'], where: ['Ohio', 'Texas'],
    signals: ['Opening a new location', 'Hiring a practice manager or hygienist'], exclude: ['Dental service organisations'], country: 'US', language: 'en',
  }
  raw.prepare('UPDATE users SET buyer_profile = ? WHERE id = ?').run(JSON.stringify(icp), id)
  raw.prepare('INSERT INTO outreach_settings (tenant_id, sender_name, postal_address) VALUES (?, ?, ?)').run(id, 'Demo Owner, Harbour Dental Supply', '100 Demo Street, Columbus, OH 43004 (staging test address)')

  const db = sqliteDb(raw)
  const lead = (company: string, slug: string, signal: string, quote: string, daysAgo: number, fit: number): LeadRow => ({
    name: 'Practice owner', company, contact: null, signal, source_url: `https://${slug}.example.test/news/new-location`, score: 60 + fit * 4,
    evidence_excerpt: quote, event_date: new Date((now - daysAgo * DAY) * 1000).toISOString().slice(0, 10), date_status: 'verified', retrieved_at: now - 2 * DAY,
    confidence: 80, dedup_key: `staging-demo:${slug}`, fit, intent: 4, action: 4, why: `${signal} (staging test data)`, signal_kind: 'expansion', source_kind: 'company_site',
  })
  const scans: { query: string; daysAgo: number; leads: LeadRow[] }[] = [
    { query: 'Dental practices in Ohio opening a new location', daysAgo: 6, leads: [
      lead('Lakeside Family Dental (demo)', 'lakeside-dental', 'Opening a second location in Dublin, Ohio', 'Lakeside Family Dental will open its second office in Dublin this spring. (staging test data)', 12, 5),
      lead('Maple Street Smiles (demo)', 'maple-smiles', 'Expanding to a new office in Akron', 'Maple Street Smiles announced a new Akron office with six treatment rooms. (staging test data)', 20, 4),
      lead('Riverbend Dental Care (demo)', 'riverbend-dental', 'New location opening in Toledo', 'Riverbend Dental Care is opening a Toledo location next month. (staging test data)', 9, 4),
    ] },
    { query: 'Dental practices in Texas hiring a practice manager', daysAgo: 2, leads: [
      lead('Bluebonnet Dental Studio (demo)', 'bluebonnet-dental', 'Hiring a practice manager in Austin', 'Bluebonnet Dental Studio is hiring a practice manager for its Austin office. (staging test data)', 4, 5),
      lead('Gulf Coast Orthodontics (demo)', 'gulfcoast-ortho', 'Hiring a hygienist and a practice manager', 'Gulf Coast Orthodontics is hiring a hygienist and a practice manager in Houston. (staging test data)', 7, 3),
    ] },
  ]
  for (const s of scans) {
    const at = now - s.daysAgo * DAY
    const job = await createQueryJob(db, id, { query: s.query, icp: JSON.stringify(icp) }, at)
    await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [at, job])
    await finishJob(db, { id: job, attempts: 1 }, { status: 'done', error: null, leads: s.leads, candidates: s.leads.length + 3, dropped: { off_profile: 3 }, now: at + 300 })
  }
  // stub Gmail (staging only): connected, sends nothing
  startOAuth(raw, id, { env: { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, DAZL_ENV: 'staging' } as never })
  return { created: true, tenant: id }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.DB_PATH
  if (!path) { console.error('staging-seed: DB_PATH not set'); process.exit(1) }
  const raw = new Database(path)
  try {
    const r = await seedStaging(raw, process.env.STAGING_DEMO_PASSWORD ?? '')
    console.log(r.created ? `staging-seed: created ${DEMO_EMAIL}` : `staging-seed: ${DEMO_EMAIL} already exists, nothing changed`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : e); process.exitCode = 1
  } finally { raw.close() }
}
