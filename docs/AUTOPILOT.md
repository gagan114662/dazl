# Autopilot: design and legal notes

Not legal advice. Counsel should review before real tenants use it. Researched 2026-10-20 from official sources.

## What is built (email only)
Off by default, behind an operator flag (`AUTOPILOT_ENABLED=1`) and a kill switch (`AUTOPILOT_KILL=1`). The user turns it on in Settings after accepting a versioned consent text and three attestations. It sends first-touch email from the user's own Gmail (send-only scope) to leads dazl verified, with these limits:
- Warm-up: the first `AUTOPILOT_WARMUP` (default 10) sends of an account must be approved by the user.
- Daily cap (user sets, default 20, hard max 50) and one email per recipient company (domain) per 7 days. No follow-ups, no second email to the same lead.
- Only leads with a verified quote and a contact published on the cited page, confidence of 80 or more, business addresses only (no Gmail/Yahoo etc.).
- Every email carries the sender name, a postal address, an unsubscribe link and List-Unsubscribe headers. The suppression list is checked at draft, approval and again at send. Unsubscribes and bounces suppress for good.
- Pause (one click, takes effect between sends), turn off, auto-pause on 3 bounces a day, an uncertain send, or Gmail needing reconnect. Full audit log.
- Message text is a fixed template filled only from the verified lead (signal, source URL). No model-written claims yet.

Not built: reading bounce notices from the inbox (entry point `recordBounce` exists), model-written templates, per-recipient timing, calls, social DMs.

## Email: B2B cold email rules
- Canada (CASL). Sending a commercial electronic message needs consent, express or implied (s. 6): https://laws-lois.justice.gc.ca/eng/acts/E-1.6/section-6.html. Implied consent covers a published business address only if the publication has no "do not send" statement and the message is relevant to the person's business, role, functions or duties (s. 10(9)(b)): https://laws-lois.justice.gc.ca/eng/acts/E-1.6/section-10.html. CRTC says the sender must prove consent, and unsubscribe requests must be honored within 10 business days: https://www.crtc.gc.ca/eng/com500/guide.htm, https://www.crtc.gc.ca/eng/com500/faq500.htm. Penalty up to CA$10 million per violation for a business (same FAQ). The role relevance test cannot be checked automatically, so the user attests to it. Unsubscribe mechanism rules: https://laws-lois.justice.gc.ca/eng/acts/E-1.6/section-11.html. CASL applies to messages sent to or from Canada, so a Canadian sender mailing US contacts is covered.
- US (CAN-SPAM). B2B email is covered. Needs truthful headers and subject, ad identification, a valid postal address, a clear opt-out, and opt-outs honored within 10 business days; no consent is needed before the first email: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- UK (PECR/UK GDPR). Corporate subscribers can be emailed without consent, but sole traders and some partnerships count as individuals and need consent: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/. EU rules differ by country and were not researched here; treat EU recipients as out of scope until reviewed.
- Gap: CASL's published-address rule is the strictest one that fits this product, so the design follows it (published on a page, relevance attested, working unsubscribe). Role-based or personal-looking addresses on non-business pages are not distinguished yet.

## Calling (recommend: do not build autonomous calling)
- US: the FCC ruled on 2024-02-08 that AI-generated voices are "artificial" under the TCPA, so such calls need the called party's prior express consent: https://www.fcc.gov/document/fcc-confirms-tcpa-applies-ai-technologies-generate-human-voices, https://docs.fcc.gov/public/attachments/FCC-24-17A1.txt. Cold AI calls to consumer numbers are effectively banned.
- Canada: CRTC Unsolicited Telecommunications Rules (National DNCL, Telemarketing Rules, ADAD rules). Calls to business numbers are still covered by the Telemarketing and ADAD rules, and telemarketers must register with the National DNCL: https://crtc.gc.ca/eng/phone/telemarketing/biz.htm, https://crtc.gc.ca/eng/phone/telemarketing/tobligations/rules-regles.htm. Automatic dialing-announcing devices have their own restrictions. Needs counsel; not researched to the clause level.
- Recommendation: human-placed calls with call lists and scripts only, with the user dialing.

## Social DMs (recommend: do not build)
- LinkedIn does not allow third-party software or extensions that scrape or automate activity, and may restrict accounts: https://www.linkedin.com/help/linkedin/answer/a1340567, https://www.linkedin.com/help/linkedin/answer/a1341387. Automated DMs from the user's account are exactly this.
- X and Meta (Instagram, Facebook): I could not retrieve an official page from their own domains in this pass, so no claim is made. They have official messaging APIs with their own business-account and messaging-window rules that need to be read before any design.
- Recommendation: draft messages and let the user send them by hand.
