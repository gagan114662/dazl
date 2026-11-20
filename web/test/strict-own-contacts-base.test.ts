import {test} from 'node:test'
import assert from 'node:assert/strict'
import {strictOwnContactCards} from '../lib/connectors/strict-own-contacts.ts'

const host='company.example'
const card='<article><h2>Jamie Vale</h2><p>Purchasing Director</p><a href="mailto:jamie.vale@company.example">jamie.vale@company.example</a></article>'
const doc=(head:string,body='')=>'<html><head>'+head+'</head><body>'+body+card+'</body></html>'
const expected=[{name:'Jamie Vale',quote:'Purchasing Director',email:'jamie.vale@company.example'}]
test('exactly one literal root-relative base preserves exact current person card and literal mail',()=>{
 assert.deepEqual(strictOwnContactCards(doc(''),host),expected)
 assert.deepEqual(strictOwnContactCards(doc('<base href="/">'),host),expected)
 assert.deepEqual(strictOwnContactCards(doc("<base href='/'>"),host),expected)
})
test('unproved absolute, path-changing, duplicate, target and unsafe bases or refresh cannot produce a proof',()=>{
 for(const head of [
  '<base href="https://foreign.example/">','<base href="//foreign.example/">',
  '<base href="https://company.example/">','<base href="/team/">','<base href="/?x=1">',
  '<base href="/#team">','<base href="javascript:alert(1)">','<base href="&#47;">',
  '<base href=/>','<base href="/" target="_blank">','<base target="_blank">',
  '<base href="/" href="/elsewhere">','<base href="/"><base href="/">',
  '<base href="/"><meta http-equiv="refresh" content="0;url=/elsewhere">',
 ])assert.deepEqual(strictOwnContactCards(doc(head),host),[],head)
 assert.deepEqual(strictOwnContactCards(doc('','<section hidden><base href="/"></section>'),host),[])
 assert.deepEqual(strictOwnContactCards(doc('<base href="/">','<section hidden><base href="//foreign.example/"></section>'),host),[])
})
