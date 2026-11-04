# Recorded CRM sandbox captures (#569)

Files here are written by a sandbox run of the live-acceptance harness and replayed by
`test/crm-recorded-fixtures.test.ts` through the real `pushLead` on every test run:

```
cd web && CRM_ACCEPTANCE=sandbox CRM_ACCEPTANCE_PROVIDER=hubspot CRM_ACCEPTANCE_KEY=<sandbox token> \
  node --experimental-strip-types scripts/crm-live-acceptance.mts --out crm-acceptance.json \
  --record test/fixtures/crm/recorded/hubspot-sandbox.json
```

A capture keeps each exchange's method, path (no query string), status and body, with the key redacted. It
holds no headers. The lead is the harness's synthetic `dazl-acceptance-<run>@example.com` contact.
Until a sandbox run happens this folder holds no capture; `../provider-shapes.json` covers the same paths with
the providers' published response shapes.
