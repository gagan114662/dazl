// Real SQLite queue and lead-actionability path; no source or outreach transports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob } from '../lib/scan/runner.ts'
import { classifyLeads } from '../lib/scan/actionable.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { draftBlockReason } from '../lib/outreach/service.ts'

test('stored short-name exclusions hold the exact company, not partial names; domains remain label-bound', () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    db.exec("INSERT INTO users (id,email,password_hash,salt) VALUES ('W','owner@example.test','x','y')")
    saveKey(db,'W','anthropic','fixture-only-unused-key',Buffer.alloc(32,1))
    const icp=JSON.stringify({carry_exclude:['company: QX','Yé (vendor.example)','Longer Name','Exclude Acme Dental']})
    const job=createQueryJob(db,'W',{query:'Find new buyers after choosing a different offer',icp,offer:'New offer'})
    assert.equal(claimKeyedJob(db,job)?.id,job)
    const add=db.prepare(`INSERT INTO leads (id,scan_job_id,company,company_domain,contact,signal,source_url,confidence,score,fit,intent)
      VALUES (?,?,?,?,?,'signal','https://news.example/event',90,80,5,4)`)
    add.run('exact',job,' qx ','different.example',null)
    add.run('unicode',job,'YE\u0301','different.example',null)
    add.run('partial',job,'QX Works','different.example',null)
    add.run('inverse',job,'Na','different.example',null)
    add.run('domain',job,'Another firm','sub.vendor.example',null)
    add.run('contact',job,'A third firm','different.example','person@vendor.example')
    add.run('lookalike',job,'A fourth firm','notvendor.example',null)
    add.run('explicit',job,'Acme Dental',null,null)
    db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(job)
    const classified=classifyLeads(db,{id:job,user_id:'W',icp})
    const excluded=classified.filter(row=>row.missing.includes('excluded')).map(row=>row.lead_id).sort()
    assert.deepEqual(excluded,['contact','domain','exact','explicit','unicode'])
    assert.equal(draftBlockReason(db,'W','explicit'),'lead_excluded')
  } finally { db.close() }
})
