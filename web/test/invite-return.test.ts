import test from 'node:test'
import assert from 'node:assert/strict'
import {keepInvite,afterSignIn,keepClaim,claimIntent,googleStartHref,clearClaim} from '../lib/invite-return.ts'
test('invitation continuation is tab-local, fragment-only, single use and rejects non-token destinations',()=>{
 const store=new Map<string,string>();let replaced='';const old={window:globalThis.window,history:globalThis.history,sessionStorage:globalThis.sessionStorage}
 Object.assign(globalThis,{window:{location:{hash:'#t='+'a'.repeat(64),pathname:'/sign-in',search:''}},history:{replaceState:(_a:unknown,_b:string,p:string)=>{replaced=p}},sessionStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)}})
 try{keepInvite();assert.equal(replaced,'/sign-in');assert.equal(afterSignIn(),'/app/join#t='+'a'.repeat(64));assert.equal(afterSignIn(),'/app');store.set('dazl_invite','https://external.test');assert.equal(afterSignIn(),'/app')}finally{Object.assign(globalThis,old)}
})

test('a failed sign-in preserves claim intent; routing never consumes it (#416)',()=>{
 const store=new Map<string,string>();const old={window:globalThis.window,history:globalThis.history,sessionStorage:globalThis.sessionStorage}
 Object.assign(globalThis,{window:{location:{hash:'',pathname:'/sign-in',search:''}},history:{replaceState:()=>{}},sessionStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)}})
 try{
  keepClaim('a'.repeat(32)+'.'+'b'.repeat(32),'Clinic Co')
  // a failed attempt never calls afterSignIn: the intent is still whole for the retry
  assert.deepEqual(claimIntent(),{token:'a'.repeat(32)+'.'+'b'.repeat(32),business:'Clinic Co'})
  assert.equal(afterSignIn(),'/preview/claim','success routes to the claim')
  assert.ok(claimIntent()!==null,'routing did not consume the claim - only the claim page clears it')
  keepClaim('not-a-token','X'); // malformed intent is never kept
  assert.equal(claimIntent()===null || claimIntent()!.business==='Clinic Co',true)
 }finally{Object.assign(globalThis,old)}
})

test('every auth path keeps the claim: Google from sign-in/sign-up goes through the preview start, a resume enum routes to the claim (#416)',()=>{
 const store=new Map<string,string>();const old={window:globalThis.window,history:globalThis.history,sessionStorage:globalThis.sessionStorage}
 Object.assign(globalThis,{window:{location:{hash:'',pathname:'/sign-up',search:''}},history:{replaceState:()=>{}},sessionStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)}})
 try{
  assert.equal(googleStartHref(),'/api/auth/google','no claim: the plain Google start')
  const tok='c'.repeat(32)+'.'+'d'.repeat(32)
  keepClaim(tok,'Clinic Soft')
  assert.equal(googleStartHref(),'/api/preview/'+tok+'/google','a tab carrying a claim starts Google through the validating preview route')
  assert.equal(afterSignIn(),'/preview/claim','password sign-up/sign-in lands on the claim')
  clearClaim()
  assert.equal(afterSignIn('preview'),'/preview/claim','the Google-path cookie intent (resume enum) is honoured after a password sign-in')
  for(const v of ['https://evil.test','/app/settings','//evil.test',undefined,null,1]) assert.equal(afterSignIn(v),'/app','anything but the enum is a generic landing, never a redirect target')
 }finally{Object.assign(globalThis,old)}
})
