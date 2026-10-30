# Demand qualification (issue #401)

`web/lib/qualify/demand.ts` answers three separate questions about a public post, deterministically (no model, no network):

1. **Who is asking.** The post's author, from the source, never a company merely named in the text. `web/lib/replies/requester.ts` screens out job seekers, recruiters (a job ad stays a job ad even when it says "build pipeline"), vendors promoting themselves without an ask, consumers with personal needs, and announcements.
2. **What demand they show,** per the seller's rubric. The strong categories are an explicit lead-source or vendor request, list-quality or research complaints, an outbound workflow bottleneck (including deliverability), and evaluation or switching. Funding, SDR hiring and growth are **weak triggers**: true, but not demand.
3. **How sure,** as three separate 0-3 scores:
   - **evidence:** source link, date, named author;
   - **fit:** a business asker, and authority (founder, owner, sales leader);
   - **intent:** a request or evaluation scores 3, a complaint or bottleneck 2, a weak trigger 1.

**Verdict.** `high_intent` needs intent ≥ 2, fit ≥ 2 and evidence ≥ 2. A non-buyer, or a trigger-only post, is `not_demand`. Anything else is `possible`.

**Contact.** `contact_permitted` is always false: a public post, a comparison request or an evaluation is not permission to contact. Consent and the send safeguards decide that.

**Rubric choice.** The rubric comes from the tenant's own offer (`rubricFor(users.sells)`), by the same rule for every tenant; there is no per-tenant exception. One rubric exists so far, `lead-generation@1`. A seller whose offer matches no rubric gets the requester screen only, and no demand claim.

**Where it applies.** Social reply threads (`lib/replies/threads.ts`) are screened before any paid grading call. Only non-buyers and trigger-only posts are dropped there; a post the rubric does not recognise still goes to grading.

**Builds on** `claude/trusting-bell-xyya6m-demand-rubric` (the requester screen), merged here and extended. Not yet applied to scan leads (`lib/scan/lead-qualify.ts`); that is the next step.
