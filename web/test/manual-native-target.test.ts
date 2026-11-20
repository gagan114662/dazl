import assert from 'node:assert/strict'
import test from 'node:test'
import {buildManualNativeTarget,submittedTarget,targetFields} from '../app/app/manual-native-target.ts'
const profile={summary:'Urban clinics',who:['Clinic owners'],where:['A saved locality'],country:'US',industries:['Dental'],signals:['Expansion'],exclude:['Schools'],window_days:30,sizes:['Small'],research:{holds:['existing']}}
test('two manually confirmed markets and trades keep common exclusions/time bounds while retaining the saved profile',()=>{
 const initial=targetFields(profile), old=JSON.stringify(profile)
 for(const [where,country,industry,signal] of [['Bergen, Norway','NO','Refrigeration','Hiring technicians'],['Limerick, Ireland','IE','Accounting','New branch']]){
   const draft={...initial,summary:'Local '+industry,who:'Owners',where,country,industries:industry,signals:signal}
   const immutable=buildManualNativeTarget('Find '+industry,profile,draft,[{answer:'existing correction'}])!
   draft.where='changed later'
   const body=JSON.parse(immutable)
   assert.deepEqual(body,{query:'Find '+industry,icp:{...profile,summary:'Local '+industry,who:['Owners'],where:[where],country,industries:[industry],signals:[signal]},
     research_decisions:[{answer:'existing correction'}],mode:'first5',budget:{web_search:'anthropic_estimated_v1'}})
 }
 assert.equal(JSON.stringify(profile),old)
})
test('rejects removing existing place, signal, role or industry and accepts an explicitly cleared country only with target location retained',()=>{
 const initial=targetFields(profile)
 for(const f of ['where','signals','who','industries'] as const) assert.equal(buildManualNativeTarget('Find matches',profile,{...initial,[f]:''},undefined),null)
 const ok=JSON.parse(buildManualNativeTarget('Find matches',profile,{...initial,country:''},null)!)
 assert.deepEqual(ok.icp.where,profile.where)
 assert.equal('country' in ok.icp,false)
 assert.equal(buildManualNativeTarget('Find matches',profile,{...initial,country:'USA'},null),null)
})

test('a country-only target cannot be erased, but a reviewed locality can replace it',()=>{
 const countryOnly={...profile,where:[]}
 const initial=targetFields(countryOnly)
 assert.equal(buildManualNativeTarget('Find matches',countryOnly,{...initial,country:''},null),null)
 const body=buildManualNativeTarget('Find matches',countryOnly,{...initial,country:'',where:'A different locality',summary:'Reviewed buyer',who:'Reviewed owner'},null)!
 assert.deepEqual(JSON.parse(body).icp.where,['A different locality'])
 assert.equal(Object.hasOwn(JSON.parse(body).icp,'country'),false)
 assert.deepEqual(submittedTarget(body),{summary:'Reviewed buyer',who:['Reviewed owner']})
})

test('untouched display text preserves an existing criterion containing a semicolon',()=>{
 const p={...profile,where:['Region; special district']}
 const initial=targetFields(p)
 assert.deepEqual(JSON.parse(buildManualNativeTarget('Find matches',p,initial,null)!).icp.where,p.where)
})
