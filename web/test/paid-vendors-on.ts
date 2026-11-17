// Imported FIRST by tests that exercise a paid vendor's code path (Apollo, People Data Labs, ZeroBounce, OpenAI, Jina) against fakes.
// Refs #1099 (lib/paid-vendors.ts): the app calls none of them unless the operator names it in DAZL_PAID_VENDORS; these tests run as an
// operator who opted in. No request leaves the test fence either way. test/paid-vendors-*-1099.test.ts prove the default is off.
// Per file (not test/helpers/net-fence.ts) so a PR that gates one vendor selects only its own tests (gate-2 budget). An explicit value is kept.
if (process.env.DAZL_PAID_VENDORS === undefined) process.env.DAZL_PAID_VENDORS = 'apollo,pdl,zerobounce,openai,jina'
export {}
