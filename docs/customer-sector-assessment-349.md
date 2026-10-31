# Customer-sector reasoning diagnostic

Both preserved paid Nettle responses reject B2B SaaS because its customers are insurers rather than software companies. This is a demonstrated reasoning error, not a failure to find the quoted words. The raw verdict, quote and note stay intact.

This change adds a narrow diagnostic, not a semantic classifier. For a B2B SaaS/software criterion, an explicit negative rationale of the observed shape (customers are sector X, not software companies/businesses buying software services) is labeled disputed. It does not change the no to yes or unknown, establish SaaS, settle other conditions, widen criteria, or change lead eligibility. An explicit customer-target requirement for software companies suppresses the diagnostic. Other dimensions, quote rejections and genuine negative controls stay informative.

The fit-check UI shows the dispute ahead of the raw rationale and calls its quote model-cited, not supporting. New qualification execution passes the actual target criteria to the parser. Existing stored results are not rewritten or reclassified from today's criteria. A caller without the original target criteria gets no diagnostic. Diagnostic coverage is narrow and can miss other reasoning errors. It is not proof that future model outputs are correct and it does not fulfill #349.

No new provider call or production record is needed. Tests use both captured responses and the previously captured source pages. Tests include raw preservation, dimension independence, sector-general controls, real nonsoftware/geography/counterparty controls, explicit customer-target criteria and stored pipeline idempotency/unchanged lead rows. UI harness renders both captured responses through the real component with one mocked read, no execution button, desktop/mobile no overflow.

The earlier real failure is Nettle. Epoch has no paid grade. A previous report incorrectly named Epoch fit; that wording was corrected. No production Epoch save, activation, eligibility promotion, email draft or send is included.
