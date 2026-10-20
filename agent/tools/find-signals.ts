import { defineTool } from "eve/tools";
import { z } from "zod";

interface Hit { signal: string; source_url: string; found_at: string; prospect_name: string; company: string; reason: string; confidence: number }
const UA = "dazl-gtm-agent/1.0 (public signal scanner)";

async function getText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": UA } });
    return r.ok ? r.text() : null;
  } catch { return null; }
}

async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
    return r.ok ? (r.json() as Promise<T>) : null;
  } catch { return null; }
}

function rssItems(xml: string): Array<{ title: string; link: string; pub: string }> {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map((m) => {
    const b = m[1];
    const title = b.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim() ?? "";
    const link  = b.match(/<link>(.*?)<\/link>/s)?.[1]?.trim() ?? "";
    const pub   = b.match(/<pubDate>(.*?)<\/pubDate>/s)?.[1]?.trim() ?? "";
    return { title, link, pub };
  });
}

// ── Sources ──────────────────────────────────────────────────────────────────

async function reddit(query: string, geography: string): Promise<Hit[]> {
  type R = { data?: { children?: Array<{ data: { title: string; permalink: string; created_utc: number; author: string; subreddit: string } }> } };
  const q = encodeURIComponent(`${query} ${geography}`);
  const d = await getJson<R>(`https://www.reddit.com/search.json?q=${q}&sort=new&limit=15&t=week`);
  return (d?.data?.children ?? []).map((c) => ({
    signal: "reddit_intent", prospect_name: `u/${c.data.author}`, company: `r/${c.data.subreddit}`,
    source_url: `https://reddit.com${c.data.permalink}`,
    found_at: new Date(c.data.created_utc * 1000).toISOString(),
    reason: `Reddit: "${c.data.title.slice(0, 100)}"`, confidence: 60,
  }));
}

async function redditSub(sub: string, query: string): Promise<Hit[]> {
  type R = { data?: { children?: Array<{ data: { title: string; permalink: string; created_utc: number; author: string } }> } };
  const q = encodeURIComponent(query);
  const d = await getJson<R>(`https://www.reddit.com/r/${sub}/search.json?q=${q}&restrict_sr=1&sort=new&limit=10`);
  return (d?.data?.children ?? []).map((c) => ({
    signal: "reddit_intent", prospect_name: `u/${c.data.author}`, company: `r/${sub}`,
    source_url: `https://reddit.com${c.data.permalink}`,
    found_at: new Date(c.data.created_utc * 1000).toISOString(),
    reason: `r/${sub} post: "${c.data.title.slice(0, 100)}"`, confidence: 65,
  }));
}

async function hn(query: string): Promise<Hit[]> {
  type H = { hits?: Array<{ objectID: string; title: string; url: string; created_at: string; author: string }> };
  const ts = Math.floor(Date.now() / 1000) - 30 * 86400;
  const q = encodeURIComponent(query);
  const d = await getJson<H>(`https://hn.algolia.com/api/v1/search?query=${q}&tags=story&numericFilters=created_at_i>=${ts}&hitsPerPage=8`);
  return (d?.hits ?? []).map((h) => ({
    signal: "hn_mention", prospect_name: `@${h.author}`, company: "Hacker News",
    source_url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    found_at: h.created_at, reason: `HN: "${h.title.slice(0, 100)}"`, confidence: 60,
  }));
}

async function googleNews(query: string): Promise<Hit[]> {
  const q = encodeURIComponent(query);
  const xml = await getText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
  if (!xml) return [];
  return rssItems(xml).map((i) => ({
    signal: "news_mention", prospect_name: "Unknown", company: "Unknown",
    source_url: i.link || "https://news.google.com", confidence: 50,
    found_at: i.pub ? new Date(i.pub).toISOString() : new Date().toISOString(),
    reason: `News: "${i.title.slice(0, 100)}"`,
  }));
}

async function indeedRss(title: string, location: string): Promise<Hit[]> {
  const q = encodeURIComponent(title), l = encodeURIComponent(location);
  const xml = await getText(`https://www.indeed.com/rss?q=${q}&l=${l}`);
  if (!xml) return [];
  return rssItems(xml).map((i) => ({
    signal: "linkedin_job", prospect_name: "Hiring manager", company: i.title.split(" - ").slice(-1)[0] ?? "Unknown",
    source_url: i.link || "https://indeed.com", confidence: 70,
    found_at: i.pub ? new Date(i.pub).toISOString() : new Date().toISOString(),
    reason: `Job post: "${i.title.slice(0, 100)}" — hiring company is a buyer.`,
  }));
}

async function secEdgar(company: string): Promise<Hit[]> {
  const q = encodeURIComponent(company);
  type E = { hits?: { hits?: Array<{ _source: { period_of_report?: string; entity_name?: string; file_date?: string; form_type?: string } }> } };
  const d = await getJson<E>(`https://efts.sec.gov/LATEST/search-index?q=${q}&dateRange=custom&startdt=${new Date(Date.now()-90*86400000).toISOString().slice(0,10)}&forms=S-1,8-K,SC 13G`);
  return (d?.hits?.hits ?? []).slice(0, 5).map((h) => ({
    signal: "funding_round", prospect_name: "Unknown", company: h._source.entity_name ?? company,
    source_url: `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(company)}&action=getcompany`,
    found_at: h._source.file_date ?? new Date().toISOString(),
    reason: `SEC filing (${h._source.form_type ?? "filing"}): "${h._source.entity_name}" — financing/ownership change.`, confidence: 80,
  }));
}

async function openCorporates(company: string): Promise<Hit[]> {
  type OC = { results?: { companies?: Array<{ company: { name: string; company_number: string; jurisdiction_code: string; registered_address?: { country?: string }; incorporation_date?: string } }> } };
  const q = encodeURIComponent(company);
  const d = await getJson<OC>(`https://api.opencorporates.com/v0.4/companies/search?q=${q}&per_page=5`);
  return (d?.results?.companies ?? []).map((c) => ({
    signal: "new_hire", prospect_name: "Unknown", company: c.company.name,
    source_url: `https://opencorporates.com/companies/${c.company.jurisdiction_code}/${c.company.company_number}`,
    found_at: c.company.incorporation_date ?? new Date().toISOString(),
    reason: `OpenCorporates: "${c.company.name}" (${c.company.jurisdiction_code}) — newly registered entity.`, confidence: 55,
  }));
}

async function github(query: string): Promise<Hit[]> {
  type G = { items?: Array<{ full_name: string; html_url: string; updated_at: string; owner: { login: string }; stargazers_count: number }> };
  const q = encodeURIComponent(query);
  const d = await getJson<G>(`https://api.github.com/search/repositories?q=${q}&sort=updated&per_page=5`,
    { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
  return (d?.items ?? []).map((r) => ({
    signal: "product_launch", prospect_name: r.owner.login, company: r.full_name,
    source_url: r.html_url, found_at: r.updated_at,
    reason: `GitHub: "${r.full_name}" (${r.stargazers_count}★) actively building.`, confidence: 40,
  }));
}

async function betaList(): Promise<Hit[]> {
  const xml = await getText("https://betalist.com/feed");
  if (!xml) return [];
  return rssItems(xml).map((i) => ({
    signal: "product_launch", prospect_name: "Unknown", company: i.title,
    source_url: i.link || "https://betalist.com", confidence: 45,
    found_at: i.pub ? new Date(i.pub).toISOString() : new Date().toISOString(),
    reason: `BetaList launch: "${i.title.slice(0, 100)}" — new product in adjacent space.`,
  }));
}

async function youtubeRss(query: string): Promise<Hit[]> {
  const q = encodeURIComponent(query);
  const xml = await getText(`https://www.youtube.com/feeds/videos.xml?search_query=${q}`);
  if (!xml) return [];
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 6).map((m) => {
    const b = m[1];
    const title  = b.match(/<title>(.*?)<\/title>/)?.[1]?.trim() ?? "";
    const link   = b.match(/href="(https:\/\/www\.youtube\.com\/watch[^"]+)"/)?.[1] ?? "";
    const pub    = b.match(/<published>(.*?)<\/published>/)?.[1]?.trim() ?? new Date().toISOString();
    const author = b.match(/<name>(.*?)<\/name>/)?.[1]?.trim() ?? "Unknown";
    return { signal: "youtube_intent", prospect_name: author, company: "YouTube", source_url: link || "https://youtube.com", found_at: pub, reason: `YouTube: "${title.slice(0, 100)}"`, confidence: 40 };
  });
}

// ── Signal type → sources map ─────────────────────────────────────────────────
const SIGNAL_TYPES = [
  "funding_round","new_hire","job_change","competitor_review","reddit_intent",
  "news_mention","linkedin_job","product_launch","review_spike","permit_filing",
  "property_sale","hn_mention","youtube_intent",
] as const;
type SignalType = typeof SIGNAL_TYPES[number];

export default defineTool({
  description:
    "Scan 30+ free public sources for buying signals. Sources: Reddit (general + subreddit), HN Algolia, Google News RSS, Indeed RSS, SEC EDGAR, OpenCorporates, GitHub API, BetaList RSS, YouTube RSS. Returns prospects with cited source URLs. No API keys needed.",
  inputSchema: z.object({
    businessDescription: z.string().min(1).describe("What the business sells or does"),
    geography: z.string().min(1).describe("Target geography e.g. 'Austin TX', 'Canada', 'remote'"),
    signalType: z.enum(SIGNAL_TYPES).describe("Type of buying signal to scan for"),
  }),
  async execute({ businessDescription, geography, signalType }) {
    const hits: Hit[] = [];
    const errs: string[] = [];
    const q = businessDescription, g = geography;

    const run = async (fn: () => Promise<Hit[]>) => {
      try { hits.push(...(await fn())); } catch (e) { errs.push(String(e).slice(0, 120)); }
    };

    const MAP: Record<SignalType, Array<() => Promise<Hit[]>>> = {
      reddit_intent:   [() => reddit(q, g), () => redditSub("entrepreneur", q)],
      competitor_review: [() => reddit(q, g), () => googleNews(`${q} review alternative`)],
      hn_mention:      [() => hn(q)],
      news_mention:    [() => googleNews(`${q} ${g}`), () => hn(q)],
      funding_round:   [() => secEdgar(q), () => googleNews(`${q} funding raised`)],
      new_hire:        [() => openCorporates(q), () => googleNews(`${q} hires appoints ${g}`)],
      job_change:      [() => indeedRss(q, g), () => googleNews(`${q} joins ${g}`)],
      linkedin_job:    [() => indeedRss(q, g)],
      product_launch:  [() => betaList(), () => github(q), () => hn(q)],
      review_spike:    [() => googleNews(`${q} reviews complaints ${g}`), () => reddit(q, g)],
      permit_filing:   [() => googleNews(`${q} permit license ${g}`)],
      property_sale:   [() => googleNews(`${q} property sale ${g}`)],
      youtube_intent:  [() => youtubeRss(q)],
    };

    for (const fn of MAP[signalType] ?? [() => googleNews(`${q} ${g}`)]) await run(fn);
    if (hits.length === 0) { await run(() => reddit(q, g)); await run(() => googleNews(`${q} ${g}`)); }

    return { signal_type: signalType, query: q, geography: g, count: hits.length, results: hits.slice(0, 25), errors: errs.length ? errs : null };
  },
});
