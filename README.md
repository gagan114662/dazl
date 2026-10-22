# dazl

Lead research, evidence checks, and reviewed outreach from your own Gmail account.

Describe who you want to reach in plain language. dazl turns that request into an editable ideal customer profile, researches candidates, checks the cited evidence, and lets you review leads before drafting outreach. It is a web app, not the Clicky macOS app that originally occupied this repository.

## Current state

Status as of October 22, 2026. Code and automated tests are not the same as a passing production check.

| Area | Implemented | Verification and limits |
| --- | --- | --- |
| Research | Free-text scans, editable profiles, candidate research and evidence checks | Automated tests cover the pipeline; live scans have been exercised. Source coverage and yield are still being improved. |
| Lead labels | Existing 24-type signal taxonomy, queryable primary signal type, and acquisition-mode labels | Migration and write paths tested. Acquisition mode is not collector identity. Per-collector yield and signal-to-reply attribution are not complete. |
| Outreach | Review and approve exact words before sending from connected Gmail | Sent own-inbox test messages were checked in Gmail, including sender details and unsubscribe links. No real-prospect delivery claim is implied. |
| Cold sequences | Approve a three-step set once; manually send step 1; later steps are due at 3 and 7 days | All three steps reached the test inbox in a shortened-delay test. Punctual unattended scheduling is not yet verified. Production sends still require the scheduler and reply-reading connection. |
| Reply and opt-out stops | Reply reading, sequence stop rules, suppression and unsubscribe handlers | Automated coverage exists. Live reply-stop and unsubscribe checks remain pending: the production Outreach page currently has a JavaScript chunk-loading failure. |
| Campaign counts | Sent, replies, permanent bounces and opt-outs | "No bounce reported" means sent minus recorded permanent bounces, not confirmed delivery. Opens and bookings are not tracked. |
| Source workers | Separate optional connector services | Retained dependencies, not a claim that every connector has passed a live test. See each worker's documented coverage and platform restrictions. |

### Send safeguards

- The approved recipient, subject and body are checked before sending. Editing a sequence removes its approval.
- Every message includes configured sender details and an unsubscribe link.
- Reply, bounce and opt-out stop rules apply to later sequence steps.
- A shared rolling 24-hour budget caps account sends at 20. In-flight and uncertain sends reserve capacity.
- Short delays and fixture messages are limited to the designated test account and allowlisted test inbox. Ordinary recipients keep the normal delays.
- No new words are generated after a sequence is approved.

These are implemented safeguards. The pending live safety checks above are still required before describing the entire workflow as production-verified.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `web/` | Next.js web app, SQLite storage, research pipeline, Gmail and outreach logic, and tests |
| `worker/` | Optional advanced-connectors service and its tests |
| `session-worker/` | Companion session-credential connector service and its tests |
| `docs/` | dazl product, implementation and operator documentation |
| `.github/` | CI configuration |

The web app calls configured workers over HTTP. Do not remove those services merely because they run separately. Connectors remain subject to their documented consent, platform-terms and access restrictions; their presence does not authorize automated use of a platform.

## Local development

Use Node.js 22 or newer. Run the web app from `web/`:

```sh
cd web
npm ci
npm run dev
```

Open `http://localhost:3000`. Use a separate local database and local secrets, never production credentials or data.

Server configuration is feature-dependent:

- `DB_PATH`: SQLite file location. Choose an explicit local path for development.
- `DAZL_MASTER_KEY`: base64-encoded 32-byte key for encrypting stored tenant secrets. Keep it stable for that database and out of Git.
- Research uses the model-provider key configured for the account.
- Gmail features require `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and the matching callback at `/api/gmail/callback`. `PUBLIC_BASE_URL` controls the callback origin.
- Optional workers use `ADVANCED_WORKER_URL` and `ADVANCED_WORKER_TOKEN`; see their own READMEs before enabling them.

This is a development entry point, not a complete production deployment guide. See [operator documentation](docs/AUTOPILOT.md) for the outreach background-work setup and safeguards.

## Checks

```sh
cd web
npm test
npm run build
```

Worker tests run separately:

```sh
(cd worker && npm test)
(cd session-worker && npm test)
```

A passing build does not prove that the deployed server serves matching HTML and static chunks. Check the live UI after deployment, and use only an explicitly approved test inbox for send tests.

## License and notices

See [LICENSE](LICENSE). Existing copyright attribution is retained. Third-party notices in [web/NOTICE](web/NOTICE) also apply.
