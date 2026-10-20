import { defineTool } from "eve/tools";
import { z } from "zod";
import { execSync } from "child_process";

// Run an agent-browser command and return its stdout
function ab(cmd: string, timeoutMs = 20000): string {
  try {
    return execSync(`agent-browser ${cmd}`, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, AGENT_BROWSER_HEADLESS: "1" },
    }).trim();
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    return err.stdout ?? err.message ?? "";
  }
}

interface Signal {
  signal: string;
  signal_type: string;
  source_url: string;
  found_at: string;
  prospect_name: string;
  company: string;
  reason: string;
}

// --- Reddit deep comment reading ---
async function redditComments(query: string): Promise<Signal[]> {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=15&type=comment`;
  const res = await fetch(url, { headers: { "User-Agent": "dazl-gtm-agent/1.0" } });
  if (!res.ok) return [];
  const json: unknown = await res.json();
  const data = json as { data?: { children?: Array<{ data: { body: string; permalink: string; author: string; subreddit: string; created_utc: number } }> } };
  const children = data?.data?.children ?? [];
  return children
    .filter(c => c.data.body.length > 50)
    .map(c => ({
      signal: "reddit_comment_intent",
      signal_type: "reddit_intent",
      source_url: `https://reddit.com${c.data.permalink}`,
      found_at: new Date(c.data.created_utc * 1000).toISOString(),
      prospect_name: c.data.author,
      company: c.data.subreddit,
      reason: c.data.body.slice(0, 300),
    }));
}

// --- Reddit post search + read comments on top results ---
async function redditPostComments(query: string): Promise<Signal[]> {
  const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=month&limit=5`;
  const res = await fetch(searchUrl, { headers: { "User-Agent": "dazl-gtm-agent/1.0" } });
  if (!res.ok) return [];
  const json: unknown = await res.json();
  const data = json as { data?: { children?: Array<{ data: { permalink: string; title: string; url: string; author: string } }> } };
  const posts = data?.data?.children ?? [];
  const signals: Signal[] = [];
  for (const post of posts.slice(0, 3)) {
    const commentUrl = `https://www.reddit.com${post.data.permalink}.json?limit=20`;
    try {
      const cr = await fetch(commentUrl, { headers: { "User-Agent": "dazl-gtm-agent/1.0" } });
      if (!cr.ok) continue;
      const cj: unknown = await cr.json();
      const arr = cj as Array<{ data?: { children?: Array<{ data: { body?: string; author?: string; created_utc?: number } }> } }>;
      const comments = arr[1]?.data?.children ?? [];
      for (const c of comments) {
        if (!c.data.body || c.data.body.length < 40) continue;
        signals.push({
          signal: "reddit_comment_on_relevant_post",
          signal_type: "reddit_intent",
          source_url: `https://reddit.com${post.data.permalink}`,
          found_at: new Date((c.data.created_utc ?? 0) * 1000).toISOString(),
          prospect_name: c.data.author ?? "unknown",
          company: "reddit",
          reason: c.data.body.slice(0, 300),
        });
      }
    } catch {
      // skip on error
    }
  }
  return signals;
}

// --- G2 competitor reviews (unhappy customers) ---
function g2Reviews(competitorSlug: string): Signal[] {
  const snap = ab(`open "https://www.g2.com/products/${competitorSlug}/reviews?filters[comment_answer_values]=1star,2star" snapshot --text`);
  const signals: Signal[] = [];
  const lines = snap.split("\n").filter(l => l.length > 40);
  let i = 0;
  for (const line of lines) {
    if (line.toLowerCase().includes("review") || line.toLowerCase().includes("cons") || line.toLowerCase().includes("dislike")) {
      signals.push({
        signal: "competitor_negative_review",
        signal_type: "competitor_unhappy_customer",
        source_url: `https://www.g2.com/products/${competitorSlug}/reviews`,
        found_at: new Date().toISOString(),
        prospect_name: "reviewer_" + i++,
        company: competitorSlug,
        reason: line.slice(0, 300),
      });
    }
    if (signals.length >= 10) break;
  }
  return signals;
}

// --- LinkedIn: people posting about a pain point ---
function linkedinPainPosts(query: string): Signal[] {
  const encoded = encodeURIComponent(query);
  const snap = ab(`open "https://www.linkedin.com/search/results/content/?keywords=${encoded}&sortBy=date_posted" snapshot --text`);
  const signals: Signal[] = [];
  const lines = snap.split("\n").filter(l => l.trim().length > 60);
  for (const line of lines.slice(0, 20)) {
    if (line.includes("http") || line.includes("@") || line.length < 60) continue;
    signals.push({
      signal: "linkedin_pain_post",
      signal_type: "linkedin_intent",
      source_url: "https://www.linkedin.com/search/results/content/?keywords=" + encoded,
      found_at: new Date().toISOString(),
      prospect_name: "linkedin_user",
      company: "linkedin",
      reason: line.slice(0, 300),
    });
    if (signals.length >= 5) break;
  }
  return signals;
}

// --- LinkedIn: who engaged with competitor posts ---
function linkedinCompetitorEngagers(companySlug: string): Signal[] {
  const snap = ab(`open "https://www.linkedin.com/company/${companySlug}/posts/" snapshot --text`);
  const signals: Signal[] = [];
  const lines = snap.split("\n").filter(l => l.trim().length > 30);
  for (const line of lines.slice(0, 15)) {
    signals.push({
      signal: "linkedin_competitor_follower",
      signal_type: "competitor_engagement",
      source_url: `https://www.linkedin.com/company/${companySlug}/posts/`,
      found_at: new Date().toISOString(),
      prospect_name: "linkedin_engager",
      company: companySlug,
      reason: `Engaged with ${companySlug} on LinkedIn: ${line.slice(0, 200)}`,
    });
    if (signals.length >= 5) break;
  }
  return signals;
}

// --- Meta Ad Library: competitor ads (public, no login) ---
function metaAdLibrary(companyName: string): Signal[] {
  const q = encodeURIComponent(companyName);
  const snap = ab(`open "https://www.facebook.com/ads/library/?q=${q}&search_type=keyword_unordered&active_status=active&ad_type=all&country=ALL" snapshot --text`);
  const signals: Signal[] = [];
  const lines = snap.split("\n").filter(l => l.trim().length > 40);
  for (const line of lines.slice(0, 10)) {
    signals.push({
      signal: "competitor_meta_ad",
      signal_type: "competitor_ad",
      source_url: `https://www.facebook.com/ads/library/?q=${q}&search_type=keyword_unordered`,
      found_at: new Date().toISOString(),
      prospect_name: companyName,
      company: companyName,
      reason: `Competitor ad creative: ${line.slice(0, 300)}`,
    });
    if (signals.length >= 5) break;
  }
  return signals;
}

// --- Google Ads Transparency: competitor ads (public, no login) ---
function googleAdsTransparency(companyName: string): Signal[] {
  const q = encodeURIComponent(companyName);
  const snap = ab(`open "https://adstransparency.google.com/?query=${q}&region=anywhere" snapshot --text`);
  const signals: Signal[] = [];
  const lines = snap.split("\n").filter(l => l.trim().length > 40);
  for (const line of lines.slice(0, 8)) {
    signals.push({
      signal: "competitor_google_ad",
      signal_type: "competitor_ad",
      source_url: `https://adstransparency.google.com/?query=${q}`,
      found_at: new Date().toISOString(),
      prospect_name: companyName,
      company: companyName,
      reason: `Competitor Google ad: ${line.slice(0, 300)}`,
    });
    if (signals.length >= 4) break;
  }
  return signals;
}

// --- LinkedIn job postings: companies in growth phase ---
function linkedinJobSignals(jobTitle: string, location: string): Signal[] {
  const kw = encodeURIComponent(jobTitle);
  const loc = encodeURIComponent(location);
  const snap = ab(`open "https://www.linkedin.com/jobs/search?keywords=${kw}&location=${loc}&f_TPR=r604800" snapshot --text`);
  const signals: Signal[] = [];
  const lines = snap.split("\n").filter(l => l.trim().length > 20);
  for (const line of lines.slice(0, 20)) {
    if (line.includes("ago") || line.includes("day") || line.includes("week")) {
      signals.push({
        signal: "company_hiring_signal",
        signal_type: "hiring_intent",
        source_url: `https://www.linkedin.com/jobs/search?keywords=${kw}&location=${loc}`,
        found_at: new Date().toISOString(),
        prospect_name: "hiring_manager",
        company: line.slice(0, 80),
        reason: `Actively hiring ${jobTitle} in ${location} — growth signal`,
      });
    }
    if (signals.length >= 8) break;
  }
  return signals;
}

// --- Capterra reviews (unhappy competitor customers) ---
function capterraReviews(competitorName: string): Signal[] {
  const q = encodeURIComponent(competitorName);
  const snap = ab(`open "https://www.capterra.com/search/?search=${q}" snapshot --text`);
  const signals: Signal[] = [];
  const lines = snap.split("\n").filter(l => l.trim().length > 40);
  for (const line of lines.slice(0, 10)) {
    if (line.toLowerCase().includes("cons") || line.toLowerCase().includes("dislike") || line.toLowerCase().includes("wish")) {
      signals.push({
        signal: "competitor_capterra_complaint",
        signal_type: "competitor_unhappy_customer",
        source_url: `https://www.capterra.com/search/?search=${q}`,
        found_at: new Date().toISOString(),
        prospect_name: "capterra_reviewer",
        company: competitorName,
        reason: line.slice(0, 300),
      });
    }
    if (signals.length >= 5) break;
  }
  return signals;
}

// --- HN: people asking for solutions ---
async function hackerNewsIntent(query: string): Promise<Signal[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - 2592000}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json: unknown = await res.json();
  const data = json as { hits?: Array<{ comment_text?: string; author?: string; story_url?: string; created_at?: string }> };
  return (data.hits ?? []).slice(0, 10).map(h => ({
    signal: "hn_comment_intent",
    signal_type: "forum_intent",
    source_url: h.story_url ?? "https://news.ycombinator.com",
    found_at: h.created_at ?? new Date().toISOString(),
    prospect_name: h.author ?? "unknown",
    company: "hacker_news",
    reason: (h.comment_text ?? "").slice(0, 300),
  }));
}

export default defineTool({
  description:
    "Deep signal scanner. Reads LinkedIn comments, G2/Capterra competitor reviews, Meta and Google ad libraries, Reddit comment threads, HN, and LinkedIn job postings. Uses agent-browser for platforms needing a browser and free public APIs elsewhere. No API keys needed.",
  inputSchema: z.object({
    businessDescription: z.string().describe("What the business does and who it serves"),
    geography: z.string().describe("Target geography e.g. Toronto, North America, global"),
    intent: z.string().describe("The pain, job title, or competitor name to track"),
    signalTypes: z
      .array(
        z.enum([
          "reddit_comments",
          "linkedin_pain_posts",
          "linkedin_competitor_engagement",
          "linkedin_jobs",
          "g2_competitor_reviews",
          "capterra_competitor_reviews",
          "meta_competitor_ads",
          "google_competitor_ads",
          "hn_intent",
        ])
      )
      .describe("Which signal types to run"),
  }),
  async execute({ businessDescription: _bd, geography, intent, signalTypes }) {
    const results: Signal[] = [];
    for (const type of signalTypes) {
      try {
        switch (type) {
          case "reddit_comments":
            results.push(...(await redditComments(intent)));
            results.push(...(await redditPostComments(intent)));
            break;
          case "linkedin_pain_posts":
            results.push(...linkedinPainPosts(intent));
            break;
          case "linkedin_competitor_engagement":
            results.push(...linkedinCompetitorEngagers(intent.replace(/\s+/g, "-").toLowerCase()));
            break;
          case "linkedin_jobs":
            results.push(...linkedinJobSignals(intent, geography));
            break;
          case "g2_competitor_reviews":
            results.push(...g2Reviews(intent.replace(/\s+/g, "-").toLowerCase()));
            break;
          case "capterra_competitor_reviews":
            results.push(...capterraReviews(intent));
            break;
          case "meta_competitor_ads":
            results.push(...metaAdLibrary(intent));
            break;
          case "google_competitor_ads":
            results.push(...googleAdsTransparency(intent));
            break;
          case "hn_intent":
            results.push(...(await hackerNewsIntent(intent)));
            break;
        }
      } catch {
        // skip failed source, continue
      }
    }
    return {
      total: results.length,
      signals: results,
      sources_tried: signalTypes,
    };
  },
});
