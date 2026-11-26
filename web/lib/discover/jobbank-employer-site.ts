const BLOCKED = /(?:^|\.)(?:jobbank\.gc\.ca|guichetemplois\.gc\.ca|indeed\.[a-z.]+|linkedin\.com|facebook\.com|instagram\.com|google\.[a-z.]+|square\.[a-z.]+|janeapp\.[a-z.]+|careerbeacon\.com|glassdoor\.[a-z.]+|monster\.[a-z.]+|ziprecruiter\.com|workopolis\.com|gmail\.com|hotmail\.[a-z.]+|outlook\.com|yahoo\.[a-z.]+|live\.com|icloud\.com|aol\.com|protonmail\.com|yandex\.[a-z.]+|talent\.com|greenhouse\.io|lever\.co|myworkdayjobs\.com|workday\.com|eluta\.ca|jobillico\.com|canada\.ca|smartrecruiters\.com|bamboohr\.com|icims\.com|jobvite\.com|workable\.com)$/i;

/** Finds an employer-owned website explicitly printed or linked in a Job Bank posting. */
export function findJobBankEmployerSite(html: string, _postingUrl?: string): string | null {
  const candidates: string[] = [];
  const clean = (value: string) => value.replace(/&amp;/gi, '&').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_m, hex, dec) => String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10)));
  const anchors = /<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const m of html.matchAll(anchors)) {
    const href = clean(m[3].trim());
    const label = clean(m[5].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    if (/website|web site|visit (our )?site/i.test(label) || /website/i.test(m[1] + m[4]) || /website|web\s+site/i.test(html.slice(Math.max(0, m.index! - 100), m.index!))) candidates.push(href);
  }
  const websiteField = /(?:Website|Web\s+site)\s*:?\s*(?:<[^>]*>\s*)*([^<\s]+(?:\s*<[^>]*>)?)/gi;
  for (const m of html.matchAll(websiteField)) candidates.push(clean(m[1]));
  for (let value of candidates) {
    value = value.trim().replace(/[),.;]+$/, '');
    if (!value) continue;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !value.startsWith('//')) value = 'https://' + value;
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
      if (!host || !host.includes('.') || BLOCKED.test(host)) continue;
      if (/\.(?:gmail|hotmail|outlook|yahoo|live|icloud|aol|protonmail)\./i.test(host)) continue;
      return host;
    } catch { /* Ignore malformed candidate. */ }
  }
  return null;
}
