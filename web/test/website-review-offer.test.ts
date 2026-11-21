import assert from 'node:assert/strict'
import test from 'node:test'
import { canQuoteWebsiteDraft, websiteReviewOffer } from '../app/app/leads/website-review-offer.ts'
const profile={offer:'Appointment scheduling',seller:'Appointment scheduling',business:'Previously Saved Business'}
test('website review presents the exact request offer against a different saved offer',()=>{
  let result=websiteReviewOffer('Find operations leaders; Seller: Fixture Systems (fixture.example), reviewed outreach',profile,'Website draft content')
  assert.equal(result.conflict?.stated,'Fixture Systems (fixture.example), reviewed outreach')
  assert.equal(result.conflict?.recorded,profile.offer)
  result=websiteReviewOffer('Find operations leaders',profile,'Fixture Systems (fixture.example), reviewed outreach')
  assert.equal(result.conflict?.stated,'Fixture Systems (fixture.example), reviewed outreach')
  assert.equal(result.conflict?.recorded,profile.offer)
})
test('does not override explicit ambiguity or invent a candidate for a clipped site draft',()=>{
  assert.equal(websiteReviewOffer('Find operations leaders',profile,'Fixture (the tool').conflict,null)
  assert.equal(websiteReviewOffer('Find operations leaders',profile,'').offer,profile.offer)
})

test('website draft cannot be bypassed by direct Find Leads or re-used after edit-and-return', () => {
  const draft={query:'Find operations leaders',invalidated:false}
  assert.equal(canQuoteWebsiteDraft(null,draft.query,false),true)
  assert.equal(canQuoteWebsiteDraft(draft,draft.query,false),false)
  assert.equal(canQuoteWebsiteDraft(draft,draft.query,true),true)
  assert.equal(canQuoteWebsiteDraft(draft,'Different request',true),false)
  assert.equal(canQuoteWebsiteDraft({...draft,invalidated:true},draft.query,true),false)
})
