import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { SIGNED_SHELL_TIMING_BROWSER } from "../lib/ops/signed-shell-timing-browser.ts"
import test from 'node:test'
import assert from 'node:assert/strict'
import { issueShellTimingReceipt,parseBrowserShellTiming,shellRoute,shellTimingEnabled,sqliteContention,verifyShellTimingReceipt } from '../lib/ops/signed-shell-timing.ts'
const id='12345678-0000-4000-8000-123456789abc',now=1000,key=Buffer.alloc(32,100),route='/app' as const
test('signed shell timing is default off and allows only three exact normalized routes',()=>{
  assert.equal(shellTimingEnabled({}),false)
  assert.equal(shellTimingEnabled({DAZL_SIGNED_SHELL_TIMING:'true'}),false)
  assert.equal(shellTimingEnabled({DAZL_SIGNED_SHELL_TIMING:'1'}),true)
  assert.equal(shellTimingEnabled({DAZL_ENV:'staging'}),true)
  assert.equal(shellTimingEnabled({DAZL_ENV:'staging',DAZL_SIGNED_SHELL_TIMING:'0'}),false)
  assert.equal(shellTimingEnabled({DAZL_ENV:'production'}),false)
  assert.equal(shellRoute('/app/business'),'/app/business')
  assert.equal(shellRoute('/app?profile=private'),null)
  assert.equal(shellRoute('/app/leads'),null)
})
test('browser telemetry is schema bounded and only joins its real document session and route',()=>{
  const receipt=issueShellTimingReceipt(route,id,'fake-session',now,key)!
  assert.equal(verifyShellTimingReceipt(route,id,receipt,'fake-session',now,key),true)
  assert.equal(verifyShellTimingReceipt('/app/plays',id,receipt,'fake-session',now,key),false)
  assert.equal(verifyShellTimingReceipt(route,id,receipt,'foreign-session',now,key),false)
  assert.equal(verifyShellTimingReceipt(route,id,receipt,'fake-session',now+60_000,key),false)
  const report={kind:'signed_shell_timing',route,request_id:id,receipt,ttfb_ms:20,auth_marker_ms:30,js_failed:0,css_failed:1,observation:'load'}
  assert.deepEqual(parseBrowserShellTiming(report),report)
  for(const a of [{...report,asset_url:'/private/location?email=1'},{...report,css_failed:9},{...report,ttfb_ms:Infinity},{...report,route:'/app/business/extra'}])
    assert.equal(parseBrowserShellTiming(a),null)
})
test('SQLite diagnostics recognize bounded enums without reading exception messages',()=>{
  assert.equal(sqliteContention({code:'SQLITE_BUSY_TIMEOUT',get message(){throw Error('unreadable')}}),'busy')
  assert.equal(sqliteContention({code:'SQLITE_LOCKED_SHAREDCACHE'}),'locked')
  assert.equal(sqliteContention({code:'BUSY',message:'private: SQLITE_BUSY'}),null)
})

test('early browser probe reports only same-origin Next error counts and real Navigation Timing, without asset URLs',()=>{
  class FakeElement {
    readonly tagName:string
    readonly props:Record<string,string>
    constructor(tagName:string,props:Record<string,string>){this.tagName=tagName;this.props=props}
    getAttribute(k:string){return this.props[k]??null}
  }
  const listeners:Record<string,(e:unknown)=>void>={}
  const calls:{url:string;body:string}[]=[]
  const fakeTiming={requestStart:30,responseStart:151,serverTiming:[{name:'dazl_request',description:id+'.61000.'+'a'.repeat(64)}]}
  const flags={location:{pathname:'/app',origin:'https://example.test'},Element:FakeElement,URL,
    document:{documentElement:{},querySelector:()=>null},performance:{getEntriesByType:()=>[fakeTiming],now:()=>1000},
    MutationObserver:class{observe(){}disconnect(){}},addEventListener:(n:string,f:(e:unknown)=>void)=>{listeners[n]=f},
    removeEventListener:()=>{},setTimeout:()=>undefined,
    fetch:(url:string,init:{body:string})=>{calls.push({url,body:init.body});return Promise.resolve({})},
  }
  runInNewContext(SIGNED_SHELL_TIMING_BROWSER,flags)
  listeners.error({target:new FakeElement('SCRIPT',{src:'/_next/static/chunks/a.js?do-not-log'})})
  listeners.error({target:new FakeElement('LINK',{rel:'stylesheet',href:'/_next/static/css/a.css?do-not-log'})})
  listeners.error({target:new FakeElement('SCRIPT',{src:'https://external.example/_next/static/must-not-log.js'})})
  listeners.pagehide({})
  listeners.pagehide({})
  assert.equal(calls.length,1)
  const r=JSON.parse(calls[0].body)
  assert.equal(calls[0].url,'/api/client-errors')
  assert.equal(r.ttfb_ms,121)
  assert.equal(r.js_failed,1)
  assert.equal(r.css_failed,1)
  assert.equal(r.auth_marker_ms,null)
  assert.equal(r.observation,'pagehide')
  assert.doesNotMatch(calls[0].body,/do-not-log|external\.example|_next/)
})

test('real SQLite cross-connection exclusive contention maps to the safe busy enum',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dazl-shell-sqlite-lock-'))
  const first=new Database(join(dir,'test.db')), second=new Database(join(dir,'test.db'),{timeout:0})
  try {
    first.exec('CREATE TABLE stamp (id integer); INSERT INTO stamp VALUES (1); BEGIN EXCLUSIVE')
    assert.throws(()=>second.prepare('SELECT * FROM stamp').get(),e=>sqliteContention(e)==='busy')
  } finally {
    first.close();second.close();rmSync(dir,{recursive:true,force:true})
  }
})
