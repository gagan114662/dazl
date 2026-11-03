import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {systemMailAvailable} from '../lib/system-mail.ts'
test('reset availability is runtime deployment-only; existing token reset remains enabled without mail',()=>{
 const page=readFileSync('app/reset/page.tsx','utf8'),form=readFileSync('app/reset/reset-form.tsx','utf8')
 assert.match(page,/await connection\(\)/);assert.match(page,/mailAvailable=\{systemMailAvailable\(\)\}/)
 assert.doesNotMatch(page,/getDb|emailStatus|findPasswordUser/)
 assert.equal(systemMailAvailable({}),false);assert.equal(systemMailAvailable({SYSTEM_MAIL_SMTP_URL:'smtp://fixture',SYSTEM_MAIL_FROM:'fixture@example.test'}),true)
 assert.match(form,/disabled=\{busy \|\| \(!token && !mailAvailable\)\}/)
 assert.match(form,/Email delivery is not available right now/)
})
