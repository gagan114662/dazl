import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { migrateScan, createJob } from "../lib/scan/store.ts"
import { migrateConnectors } from "../lib/connectors/store.ts"
import { crawlJob } from "../lib/connectors/sitecrawl.ts"

// Regression from independent review 5949221231. Synthetic probes, never live evidence.
type Options = { search?: "empty" | "namesake" | "repeat" | "abort"; localWorks?: boolean; leads?: number }
async function probe(linked: boolean, externalFails = false, opts: Options = {}) {
  const db = new Database(":memory:"); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, "A", { business_name: "Seller", industry: "agency", location: "Toronto" })
  db.prepare("UPDATE scan_jobs SET status = ?, icp = ? WHERE id = ?").run("running", JSON.stringify({ where: ["Toronto, Ontario"], who: ["Founder"] }), job)
  const source = "https://jobs.ashbyhq.com/harbordental/123"
  db.prepare("INSERT INTO leads (id,scan_job_id,company,source_url,review_reason,score,signal) VALUES (?,?,?,?,?,?,?)").run("L", job, "Harbor Dental", source, "no_sales_hiring_evidence", 70, "Hiring in Toronto")
  const subset = [{ id: "L", company: "Harbor Dental", source_url: source }]
  for (let i = 1; i < (opts.leads ?? 1); i++) {
    const id = `L${i}`
    db.prepare("INSERT INTO leads (id,scan_job_id,company,source_url,review_reason,score,signal) VALUES (?,?,?,?,?,?,?)").run(id, job, "Harbor Dental", source, "no_sales_hiring_evidence", 70, "Hiring in Toronto")
    subset.push({ id, company: "Harbor Dental", source_url: source })
  }
  const ctrl = new AbortController()
  const events: string[] = []
  await crawlJob(db, "A", job, { env: {}, gapMs: 0, signal: ctrl.signal, leads: subset,
    get: async url => {
      events.push(url)
      if (url === source) return { status: 200, body: linked ? `<a href="https://harbordentalold.com/">Harbor Dental website</a>` : "", finalUrl: url }
      const u = new URL(url)
      if (u.hostname !== (opts.localWorks ? "harbordentalold.com" : "harbordentalofficial.com")) return null
      return { status: 200, body: u.pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : opts.search === "namesake" ? "<h1>Harbor Dental</h1><p>8500 Whittier Blvd, Pico Rivera, CA 90660</p>" : "<h1>Harbor Dental</h1><p>156 Front Street West, Toronto, Ontario</p>", finalUrl: url }
    },
    redirectOf: async () => null,
    findSites: async () => { events.push("official_search"); if (externalFails) throw new Error("provider error"); if (opts.search === "abort") ctrl.abort(); return opts.search === "empty" ? [] : opts.search === "repeat" ? ["harbordentalold.com", "harbordentalofficial.com"] : ["harbordentalofficial.com"] }
  })
  const lead = db.prepare("SELECT company_domain, review_reason FROM leads WHERE id = ?").get("L") as {company_domain: string | null; review_reason: string}
  const reasons = db.prepare("SELECT kind,value,label FROM lead_enrichments WHERE lead_id = ?").all("L") as { kind: string; value: string; label: string }[]
  db.close(); return { lead, events, reasons }
}
test("independent fallback control: no linked website, failed slug then official search resolves domain", async () => {
  const p = await probe(false); assert.equal(p.lead.company_domain, "harbordentalofficial.com"); assert.ok(p.events.includes("official_search")); assert.equal(p.lead.review_reason, "no_sales_hiring_evidence")
})
test("independent fallback: unreachable posting-linked website must not suppress official search after failed slug", async () => {
  const p = await probe(true); assert.equal(p.lead.company_domain, "harbordentalofficial.com", JSON.stringify(p)); assert.ok(p.events.includes("official_search"))
})
test("independent provider-error control: no invented domain and a stored unresolved reason", async () => {
  const p = await probe(false, true); assert.equal(p.lead.company_domain, null); assert.equal(p.lead.review_reason, "no_sales_hiring_evidence"); assert.ok(p.events.includes("official_search")); assert.ok(p.reasons.some(r => r.value === "No company website confirmed"))
})

test("confirmed posting candidate never pays for fallback search", async () => {
  const p = await probe(true, false, { localWorks: true })
  assert.equal(p.lead.company_domain, "harbordentalold.com")
  assert.ok(!p.events.includes("official_search"))
})

for (const mode of ["empty", "namesake", "abort"] as const) test(`stale linked site: ${mode} fallback preserves honest null`, async () => {
  const p = await probe(true, false, { search: mode })
  assert.equal(p.lead.company_domain, null)
  assert.equal(p.lead.review_reason, "no_sales_hiring_evidence")
  assert.equal(p.events.filter(e => e === "official_search").length, 1)
  if (mode !== "abort") assert.ok(p.reasons.some(r => r.value === "No company website confirmed"))
  else assert.ok(!p.events.some(e => e.includes("harbordentalofficial.com")))
})

test("stale linked site: failed provider preserves null and plain-language reason", async () => {
  const p = await probe(true, true)
  assert.equal(p.lead.company_domain, null)
  assert.ok(p.events.includes("official_search"))
  assert.ok(p.reasons.some(r => r.value === "No company website confirmed"))
})

test("fallback follows local candidates and reuses failed host cache without network retry", async () => {
  const p = await probe(true, false, { search: "repeat" })
  assert.equal(p.lead.company_domain, "harbordentalofficial.com")
  const staleReads = p.events.filter(e => e.includes("harbordentalold.com"))
  assert.equal(staleReads.length, 1)
  assert.ok(p.events.indexOf(staleReads[0]) < p.events.indexOf("official_search"))
  assert.ok(p.reasons.some(r => r.kind === "domain_check" && r.value === "harbordentalofficial.com|identity_checked"))
})

test("anchored fallbacks share the existing twenty-lead probe cap", async () => {
  const p = await probe(true, true, { leads: 21 })
  assert.equal(p.events.filter(e => e === "official_search").length, 20)
  assert.equal(p.lead.company_domain, null)
})
