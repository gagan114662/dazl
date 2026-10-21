// lib/scrape/jina.ts
// Drop-in web scraper — returns clean markdown from any URL
// Uses Jina Reader (free, no key needed, handles JS)
// Usage: const md = await scrapePage("https://techcrunch.com/...")

export async function scrapePage(url: string): Promise<string> {
  const jinaUrl = `${process.env.JINA_READER_URL || "https://r.jina.ai"}/${url}`;
  const res = await fetch(jinaUrl, {
    headers: { Accept: "text/markdown" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Jina fetch failed ${res.status} for ${url}`);
  return res.text();
}

export async function scrapePages(urls: string[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        results.set(url, await scrapePage(url));
      } catch {
        results.set(url, "");
      }
    })
  );
  return results;
}
