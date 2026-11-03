// One production artifact, opposite runtime deployment settings; read-only, no submit/mail.
import assert from 'node:assert/strict'
import {loadPlaywright,startServer} from '../smoke/harness.mjs'
const {chromium}=loadPlaywright(),browser=await chromium.launch()
try{for(const available of [false,true]){
 const srv=await startServer({env:available?{SYSTEM_MAIL_SMTP_URL:'smtp://127.0.0.1:1',SYSTEM_MAIL_FROM:'fixture@example.test'}:{}})
 try{const ctx=await browser.newContext();await ctx.route('**/*',r=>new URL(r.request().url()).origin===srv.base?r.continue():r.abort());const p=await ctx.newPage();await p.goto(srv.base+'/reset')
 if(available){await p.getByText('We will email you a link that works for 30 minutes.').waitFor();assert.equal(await p.getByRole('button',{name:'Send link',exact:true}).isEnabled(),true)}
 else{await p.getByText('Email delivery is not available right now. Try again later.').waitFor();assert.equal(await p.getByRole('button',{name:'Email unavailable'}).isDisabled(),true)}
 await ctx.close()}finally{srv.stop()}
}console.log('ok same production build reflects opposite runtime SMTP availability, no mail or reset request')}finally{await browser.close()}
