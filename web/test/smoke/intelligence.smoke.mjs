// Production UI wiring on a fenced fixture. Website generation and scan admission are intercepted at the browser;
// real server recall/admission/rollback are separately covered by route tests. This does NOT prove live source yield.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadPlaywright, newContext, startServer, root } from './harness.mjs'
const { chromium }=loadPlaywright()
const out=path.join(root,'preview','intelligence');mkdirSync(out,{recursive:true})
const profile={summary:'Clinics buying scheduling software',who:[],industries:[],sizes:[],where:[],signals:[],exclude:[],research:{v:1,site:'seller.example',offers:[{i:'booking',n:'Booking'}],q:null,ans:null,hyps:[{i:'booking:persona:1',o:'booking',k:'persona',t:'Clinic managers',s:'hypothesis',u:null,q:null,at:null}]}}
const srv=await startServer();let browser
try{
 browser=await chromium.launch();const ctx=await newContext(browser,srv);const page=await ctx.newPage();await page.setViewportSize({width:1280,height:1000})
 await page.route('**/api/scan/icp-from-url',r=>r.fulfill({json:{icp:profile,sells:'Booking',source:'https://seller.example/',intelligence:{selected:[],trust:'seller_targeting_only'}}}))
 await page.route('**/api/scan/estimate',r=>r.fulfill({status:503,json:{error:'fixture_stop_before_paid_work'}}))
 await page.goto(srv.base+'/app/leads');await page.getByTestId('play-settings').locator('summary').first().click();await page.getByTestId('more-sources').locator('summary').first().click()
 await page.getByPlaceholder('Your website - we will fill the profile from it').fill('https://seller.example')
 await page.getByRole('button',{name:'Fill from my website',exact:true}).click()
 const review=page.getByTestId('research-review');await review.getByRole('button',{name:'Add',exact:true}).click()
 // Query state lives outside the review card. The buyer textarea is identified by its current exact value.
 await review.screenshot({path:path.join(out,'added.png')})
 await review.getByRole('button',{name:'Dismiss',exact:true}).click();await review.getByText('Dismissed targeting (restore explicitly)').click()
 await review.screenshot({path:path.join(out,'dismissed.png')})
 await review.getByRole('button',{name:'Restore',exact:true}).click();await review.screenshot({path:path.join(out,'restored.png')})
 const text=await review.innerText();assert.match(text,/Clinic managers[\s\S]*Added by you/)
 const buyerValues=await page.locator('textarea').evaluateAll(xs=>xs.map(x=>x.value));assert.ok(buyerValues.includes('Clinic managers'))
 console.log('PASS production ResearchReview Add/Dismiss/Restore and visible buyer-field wiring. No scan/provider called.')
 await ctx.close()
}finally{await browser?.close();srv.stop()}
