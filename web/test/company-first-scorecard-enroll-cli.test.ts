import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'

const runner = fileURLToPath(new URL('../scripts/company-first-scorecard-enroll.mts', import.meta.url))
const fence = fileURLToPath(new URL('./helpers/net-fence.ts', import.meta.url))
const fixture = 'data:text/javascript,' + encodeURIComponent('process.env.DAZL_SCORECARD_SIGNING_KEY=process.env.DAZL_TEST_ENROLL_FIXTURE;delete process.env.DAZL_TEST_ENROLL_FIXTURE;')

test('the ops CLI binds the built release and applies only the signed owner workspace, with no grant replay', () => {
  const root=mkdtempSync(path.join(tmpdir(),'dazl-enroll-cli-'))
  const file=path.join(root,'fixture.db')
  const release='a'.repeat(40), wrong='b'.repeat(40), epoch='c'.repeat(64)
  const key=randomBytes(32)
  const raw=new Database(file)
  try {
    migrateAllSqlite(raw)
    for (const tenant of ['chosen-workspace','other-workspace']) {
      const actor=tenant+'-owner'
      raw.prepare('INSERT INTO users (id,email,password_hash,salt) VALUES (?,?,?,?)').run(actor,actor+'@fixture.invalid','x','y')
      raw.prepare("INSERT INTO organizations (id,kind,created_by,created_at) VALUES (?,'team',?,1)").run(tenant,actor)
      raw.prepare("INSERT INTO memberships (tenant_id,member_id,role,created_at) VALUES (?,?,'owner',1)").run(tenant,actor)
    }
    const plain=Buffer.from(JSON.stringify(['chosen-workspace','chosen-workspace-owner',release,null,epoch,false,true,Date.now()+60_000])).toString('base64url')
    const grant=plain+'.'+createHmac('sha256',key).update('dazl-scorecard-enrollment:v1\n').update(plain).digest('hex')
    const flags=()=>raw.prepare('SELECT company_first_scorecard_enabled AS enabled FROM organizations WHERE id LIKE ? ORDER BY id').all('%-workspace')
    const invoke=(expected:string,input:string)=>spawnSync(process.execPath,
      ['--no-warnings','--experimental-strip-types','--import',fence,'--import',fixture,runner,expected],{
        cwd:root,input,encoding:'utf8',timeout:8_000,
        env:{ PATH:process.env.PATH, HOME:root, NODE_ENV:'test', DB_PATH:file, DAZL_TEST_ENROLL_FIXTURE:key.toString('hex'), DAZL_COMMIT_SHA:release },
      })
    writeFileSync(path.join(root,'.build-commit'),wrong+'\n')
    assert.equal(invoke(release,grant).status,1,'environment does not override the wrong build marker')
    assert.deepEqual(flags(),[{enabled:0},{enabled:0}])
    writeFileSync(path.join(root,'.build-commit'),release+'\n')
    assert.equal(invoke(release,grant+'\n'+grant).status,1,'only one signed grant accepted')
    assert.deepEqual(flags(),[{enabled:0},{enabled:0}])
    const applied=invoke(release,grant+'\n')
    assert.equal(applied.status,0,applied.stderr)
    assert.match(applied.stdout,/enrollment applied/)
    assert.ok(!applied.stdout.includes('chosen-workspace')&&!applied.stdout.includes(grant))
    assert.deepEqual(flags(),[{enabled:1},{enabled:0}])
    assert.equal(invoke(release,grant).status,1,'cannot replay')
    assert.deepEqual(flags(),[{enabled:1},{enabled:0}])
  } finally {
    raw.close(); key.fill(0); rmSync(root,{recursive:true,force:true})
  }
})
