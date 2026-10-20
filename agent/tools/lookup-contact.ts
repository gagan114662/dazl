import { defineTool } from "eve/tools";
import { z } from "zod";
import { promises as dns } from "node:dns";
import net from "node:net";

const UA = "Mozilla/5.0 (compatible; dazl-contact-finder/1.0)";
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const NOISE = ["example.com", "sentry", "noreply", "no-reply", "privacy@", "legal@", "wixpress", "schema.org"];

interface Hit { email: string | null; phone: string | null; source: string; confidence: string | null }

async function fetchText(url: string, extraHeaders?: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": UA, ...extraHeaders },
    });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(7000), headers: { "User-Agent": UA } });
    return res.ok ? (await res.json() as T) : null;
  } catch { return null; }
}

function extractEmails(html: string): string[] {
  return [...new Set(html.match(EMAIL_RE) ?? [])]
    .filter((e) => !NOISE.some((n) => e.toLowerCase().includes(n)))
    .filter((e) => e.length < 80);
}

// Step 1: scrape company website
async function scrapeWebsite(domain: string): Promise<Hit | null> {
  const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?[2-9]\d{2}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;
  for (const path of ["/contact", "/about", "/team", "/contact-us", "/"]) {
    const html = await fetchText(`https://${domain}${path}`);
    if (!html) continue;
    const emails = extractEmails(html);
    if (emails[0]) {
      return { email: emails[0], phone: html.match(PHONE_RE)?.[0] ?? null, source: `https://${domain}${path}`, confidence: "scraped" };
    }
  }
  return null;
}

// Step 2: common-pattern SMTP verify
async function getMx(domain: string): Promise<string | null> {
  try {
    const records = await dns.resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    return records[0]?.exchange ?? null;
  } catch { return null; }
}

async function smtpCheck(email: string, mx: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port: 25, host: mx });
    s.setTimeout(9000);
    let stage = 0;
    let buf = "";
    const done = (v: boolean) => { try { s.write("QUIT\r\n"); s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.on("timeout", () => done(false));
    s.on("error",   () => done(false));
    s.on("data", (chunk) => {
      buf += chunk.toString();
      if (!buf.includes("\n")) return;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const line of lines) {
        const code = line.slice(0, 3);
        if (stage === 0 && code === "220") { s.write("EHLO dazl.ai\r\n"); stage = 1; }
        else if (stage === 1 && line.startsWith("250 ")) { s.write("MAIL FROM:<v@dazl.ai>\r\n"); stage = 2; }
        else if (stage === 2 && code === "250") { s.write(`RCPT TO:<${email}>\r\n`); stage = 3; }
        else if (stage === 3) { done(code === "250" || code === "251"); return; }
        else if (["421", "450", "550", "503"].includes(code)) { done(false); return; }
      }
    });
  });
}

async function smtpWaterfall(domain: string): Promise<Hit | null> {
  const mx = await getMx(domain);
  if (!mx) return null;
  for (const prefix of ["info", "hello", "contact", "support", "sales", "hi"]) {
    const email = `${prefix}@${domain}`;
    let verified = false;
    try { verified = await smtpCheck(email, mx); } catch { /* port 25 may be blocked — skip */ }
    if (verified) return { email, phone: null, source: `smtp-verify:${mx}`, confidence: "smtp-verified" };
  }
  return null;
}

// Step 3: RDAP (free WHOIS)
async function tryRdap(domain: string): Promise<Hit | null> {
  const data = await fetchJson<{ entities?: Array<{ vcardArray?: [string, Array<[string, Record<string,unknown>, string, string]>] }> }>(
    `https://rdap.org/domain/${domain}`
  );
  for (const entity of data?.entities ?? []) {
    for (const field of entity?.vcardArray?.[1] ?? []) {
      if (field[0] === "email" && typeof field[3] === "string" && field[3].includes("@")) {
        return { email: field[3], phone: null, source: `rdap.org/${domain}`, confidence: "scraped" };
      }
    }
  }
  return null;
}

// Step 4: GitHub org members (public emails)
async function tryGitHub(orgName: string): Promise<Hit | null> {
  type GHUser = { login: string; email?: string | null };
  const members = await fetchJson<GHUser[]>(
    `https://api.github.com/orgs/${orgName}/members?per_page=5`
  );
  if (!members?.length) return null;
  for (const m of members.slice(0, 4)) {
    const user = await fetchJson<GHUser>(`https://api.github.com/users/${m.login}`);
    if (user?.email) {
      return { email: user.email, phone: null, source: `github.com/orgs/${orgName}`, confidence: "scraped" };
    }
  }
  return null;
}

// Step 5: Google search scrape (emails in snippets)
async function tryGoogleSearch(domain: string): Promise<Hit | null> {
  const q = encodeURIComponent(`"@${domain}" contact email`);
  const html = await fetchText(`https://www.google.com/search?q=${q}&num=5`, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  if (!html) return null;
  const emails = extractEmails(html).filter((e) => e.endsWith(`@${domain}`));
  return emails[0] ? { email: emails[0], phone: null, source: `google-search:${domain}`, confidence: "scraped" } : null;
}

export default defineTool({
  description:
    "Find email and phone for a prospect. Full scraping waterfall (no API keys needed): website scrape → SMTP pattern verify → RDAP/WHOIS → GitHub org → Google search. Returns smtp-verified, scraped, or null. Never invents an email.",
  inputSchema: z.object({
    name: z.string().min(1).describe("Prospect full name"),
    company: z.string().min(1).describe("Company name"),
    domain: z.string().optional().describe("Company domain e.g. acme.com"),
  }),
  async execute({ name: _name, company, domain }) {
    const d = domain ?? company.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9\-\.]/g, "").slice(0, 30) + ".com";
    const tried: string[] = [];

    const run = async (label: string, fn: () => Promise<Hit | null>): Promise<Hit | null> => {
      tried.push(label);
      try { return await fn(); } catch { return null; }
    };

    const result =
      await run("website",      () => scrapeWebsite(d))     ??
      await run("smtp-verify",  () => smtpWaterfall(d))     ??
      await run("rdap",         () => tryRdap(d))            ??
      await run("github-org",   () => tryGitHub(company.toLowerCase().replace(/[^a-z0-9]/g, ""))) ??
      await run("google-search", () => tryGoogleSearch(d));

    if (result) return { ...result, tried, domain: d };
    return { email: null, phone: null, source: "not_found", confidence: null, tried, domain: d,
      note: "All scraping sources returned empty. Company may use a privacy-protected domain or email obfuscation." };
  },
});
