// Quest live check #1237 (test input). Runs this dir's lib against the live made-up pages.
const L = process.argv[2]
const out: Record<string, unknown> = {}
const { counterpartySignal } = await import(`${L}/lib/scan/counterparty.ts`)
for (const p of ['news', 'customers']) {
  const url = `https://dazl.ai/dazl-test/${p}/`
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } }); const html = await r.text()
  const company = (html.match(/<p id="co">([^<]+)<\/p>/) ?? [])[1] ?? ''
  const title = (html.match(/<title>([^<]+)<\/title>/) ?? [])[1] ?? ''
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const cand = { name: '', company, contact: null, signal: '', source_url: url, score: 80, excerpt: '', event_date: null }
  let res: unknown
  try { res = counterpartySignal(cand as never, { title, text, retrievedAt: Date.now() } as never, '') } catch (e) { res = `THREW ${(e as Error).name}: ${(e as Error).message.slice(0, 160)}…` }
  out[url] = { http: r.status, company_name_length: company.length, result: res }
}
console.log(JSON.stringify(out, null, 1))
