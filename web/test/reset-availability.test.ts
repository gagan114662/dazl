import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {systemMailAvailable} from '../lib/system-mail.ts'
test('reset availability is runtime deployment-only; existing token reset remains enabled without mail',()=>{
 const page=readFileSync('app/reset/page.tsx','utf8'),form=readFileSync('app/reset/reset-form.tsx','utf8')
 assert.match(page,/await connection\(\)/);assert.match(page,/mailAvailable=\{systemMailAvailable\(\)\}/)
 assert.doesNotMatch(page,/getDb|emailStatus|findPasswordUser/)
 assert.equal(systemMailAvailable({}),false);assert.equal(systemMailAvailable({SYSTEM_MAIL_SMTP_URL:'smtp://fixture',SYSTEM_MAIL_FROM:'fixture@example.test'}),true)
 assert.match(form,/disabled=\{busy \|\| \(!token && mailAvailable === false\)\}/) // mail known to be off: no send button
 assert.match(form,/Email delivery is not available right now/)
})

// #1428: /reset showed only "Loading account recovery..." for 5-9 s on dazl.ai while its runtime part streamed in. The
// first HTML must already be the working form: the Suspense fallback renders the same form, mail state not yet known.
test('#1428 /reset is usable in its first HTML: the fallback is the form itself, never a loading line',()=>{
 const page=readFileSync('app/reset/page.tsx','utf8'),form=readFileSync('app/reset/reset-form.tsx','utf8')
 assert.doesNotMatch(page,/Loading account recovery/)
 assert.match(page,/fallback=\{<ResetForm mailAvailable=\{null\} \/>\}/)
 // unknown mail state: the email form is offered (the request route answers 503 in words if mail is off), no promise made
 assert.match(form,/mailAvailable: boolean \| null/)
 assert.match(form,/disabled=\{busy \|\| \(!token && mailAvailable === false\)\}/)
})
test('#1428 while the mail state is unknown the reset form promises nothing: no 30-minute link line, a neutral prompt',()=>{
 const form=readFileSync('app/reset/reset-form.tsx','utf8')
 // the 30-minute promise only when this deployment is known to send mail
 assert.match(form,/mailAvailable === true \? 'We will email you a link that works for 30 minutes\.'/)
 assert.match(form,/mailAvailable === null \? 'Enter the email you signed up with\.'/)
})
