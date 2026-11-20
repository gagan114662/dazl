import assert from 'node:assert/strict'
import test from 'node:test'
import {acceptedTarget,buildManualNativeTarget,targetFields} from '../app/app/manual-native-target.ts'
const profile={summary:'Urban clinics',who:['Clinic owners'],where:['A saved locality'],country:'US',industries:['Dental'],signals:['Expansion'],exclude:['Schools'],window_days:30,sizes:['Small'],research:{holds:['existing']}}
test('two manually confirmed markets and trades keep common exclusions/time bounds while retaining the saved profile',()=>{
 const initial=targetFields(profile), old=JSON.stringify(profile)
 for(const [where,country,industry,signal] of [['Bergen, Norway','NO','Refrigeration','Hiring technicians'],['Limerick, Ireland','IE','Accounting','New branch']]){
   const draft={...initial,summary:'Local '+industry,who:'Owners',where,country,industries:industry,signals:signal}
   const immutable=buildManualNativeTarget('Find '+industry,profile,draft)!
   draft.where='changed later'
   const body=JSON.parse(immutable)
   assert.deepEqual(body,{query:'Find '+industry,icp:{...profile,summary:'Local '+industry,who:['Owners'],where:[where],country,industries:[industry],signals:[signal]},
     mode:'first5',budget:{web_search:'anthropic_estimated_v1',target_review:'manual_v1'}})
 }
 assert.equal(JSON.stringify(profile),old)
})
test('rejects removing existing place, signal, role or industry and accepts an explicitly cleared country only with target location retained',()=>{
 const initial=targetFields(profile)
 for(const f of ['where','signals','who','industries'] as const) assert.equal(buildManualNativeTarget('Find matches',profile,{...initial,[f]:''}),null)
 const ok=JSON.parse(buildManualNativeTarget('Find matches',profile,{...initial,country:''})!)
 assert.deepEqual(ok.icp.where,profile.where)
 assert.equal('country' in ok.icp,false)
 assert.equal(buildManualNativeTarget('Find matches',profile,{...initial,country:'USA'}),null)
})

test('a country-only target cannot be erased, but a reviewed locality can replace it',()=>{
 const countryOnly={...profile,where:[]}
 const initial=targetFields(countryOnly)
 assert.equal(buildManualNativeTarget('Find matches',countryOnly,{...initial,country:''}),null)
 const body=buildManualNativeTarget('Find matches',countryOnly,{...initial,country:'',where:'A different locality',summary:'Reviewed buyer',who:'Reviewed owner'})!
 assert.deepEqual(JSON.parse(body).icp.where,['A different locality'])
 assert.equal(Object.hasOwn(JSON.parse(body).icp,'country'),false)
 assert.equal(JSON.parse(body).icp.summary,'Reviewed buyer')
})

test('untouched display text preserves an existing criterion containing a semicolon',()=>{
 const p={...profile,where:['Region; special district']}
 const initial=targetFields(p)
 assert.deepEqual(JSON.parse(buildManualNativeTarget('Find matches',p,initial)!).icp.where,p.where)
})

test('corrected (not original) sentence binds the wire and only the server-effective target is read back',()=>{
 const initial=targetFields(profile)
 const body=JSON.parse(buildManualNativeTarget('Find machinists in Wellington',profile,
   {...initial,where:'Wellington',country:'NZ',industries:'Metalworking',signals:'Installing new equipment'})!)
 assert.equal(body.query,'Find machinists in Wellington')
 assert.equal(Object.hasOwn(body,'research_decisions'),false)
 assert.deepEqual(body.icp.research,profile.research)
 assert.equal(acceptedTarget(undefined,body.query),null)
 assert.equal(acceptedTarget({...body.icp,query:'Find accountants in Oxford'},body.query),null)
 const effective={...body.icp,query:body.query,who:['Owners'],where:['Wellington, New Zealand']}
 const got=acceptedTarget(effective,body.query)!
 assert.deepEqual(got,{query:body.query,summary:profile.summary,who:['Owners'],where:['Wellington, New Zealand'],country:'NZ',industries:['Metalworking'],signals:['Installing new equipment'],sizes:profile.sizes,exclude:profile.exclude,window_days:30})
 effective.who.push('Later change')
 assert.deepEqual(got.who,['Owners'])
 assert.equal(acceptedTarget({...effective,where:[123]},body.query),null)
 assert.equal(acceptedTarget({...effective,window_days:0},body.query),null)
 assert.equal(acceptedTarget({...effective,language:'EN'},body.query),null)
 assert.equal(acceptedTarget({...effective,exclude:undefined},body.query),null)
 const optionalMissing=acceptedTarget({...effective,country:undefined,window_days:undefined,language:undefined},body.query)!
 assert.equal(Object.hasOwn(optionalMissing,'country'),false)
 assert.equal(Object.hasOwn(optionalMissing,'window_days'),false)
 assert.equal(Object.hasOwn(optionalMissing,'language'),false)
})
