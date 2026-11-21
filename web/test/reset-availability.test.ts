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

// #1428: /reset showed only "Loading account recovery..." for 5-9 s on dazl.ai: the form sat behind a Suspense boundary and
// appeared only when its streamed part was swapped in. Same pattern as sign-up (#668/#670): connection() with NO Suspense
// boundary and `instant = false`, so the complete form is in the first HTML and hydrates normally.
test('#1428 /reset sends the complete form in its first HTML: no Suspense boundary, no loading line',()=>{
 const page=readFileSync('app/reset/page.tsx','utf8')
 assert.doesNotMatch(page,/Loading account recovery/)
 assert.doesNotMatch(page,/<Suspense\b/)
 assert.match(page,/export const instant = false/)
 assert.match(page,/export default async function Reset\(\)/)
})
