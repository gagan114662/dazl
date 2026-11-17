// Imported FIRST by tests that drive the real crawl (sitecrawl.ts crawlJob through runJob) against stubbed hosts. sitecrawl.ts reads its
// per-host politeness gap (SITECRAWL_GAP_MS, default 2000 ms) once at load, and runJob calls crawlJob without a gapMs, so these files spent
// minutes sleeping between fake page fetches (complete-leads alone ~220 s) and pushed any PR touching sitecrawl.ts past the 5-minute PR
// budget (gate 2). The stubs answer instantly and these tests assert nothing about the gap; the gap itself stays covered by the tests that
// pass gapMs explicitly. An explicit SITECRAWL_GAP_MS from the environment is kept.
if (process.env.SITECRAWL_GAP_MS === undefined) process.env.SITECRAWL_GAP_MS = '0'
export {}
