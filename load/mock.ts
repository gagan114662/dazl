// Synthetic provider + page fixtures for the local load harness.
// No network, no real keys, no tenant data. Every URL, company and email below
// is on reserved .example names and exists only inside the benchmark process.
import type { Provider, ResearchResult } from '../web/lib/llm/provider.ts'
import type { Page } from '../web/lib/scan/fetch-page.ts'
import type { LeadDraft } from '../web/lib/scan/runner.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export interface MockOptions {
  providerMs: number   // simulated LLM latency per research call
  fetchMs: number      // simulated page-fetch latency
}

export interface SyntheticLead { lead: LeadDraft; pageText: string; pageTitle: string }

// One deterministic synthetic lead set per job. The excerpt (20-300 chars) names the
// company and carries the current year so the real verifier accepts it, and the mocked
// page text contains the excerpt verbatim plus the contact, exactly like a real pass.
export function syntheticBatch(jobId: string, now: Date, count: number): SyntheticLead[] {
  const day = now.toISOString().slice(0, 10)
  const year = now.getUTCFullYear()
  const out: SyntheticLead[] = []
  for (let i = 0; i < count; i++) {
    const company = `Loadtest ${jobId.slice(0, 6)}-${i}`
    const contact = `info@loadtest-${jobId.slice(0, 6)}-${i}.example`
    const excerpt = `${company} announced a ${year} expansion, hiring 40 roles in Toronto this quarter, per its October ${year} press note.`
    out.push({
      lead: {
        name: `Pat ${i}`,
        company,
        contact,
        signal: 'Expansion and hiring signal',
        source_url: `https://news-loadtest.example/${jobId}/${i}`,
        excerpt,
        event_date: day,
        score: 70,
      },
      pageTitle: `${company} news`,
      pageText: `Local business wire.\n\n${excerpt}\n\nReach them at ${contact}. Published ${day}.`,
    })
  }
  return out
}

// Research calls do not carry the job id, so batches are handed out FIFO, one per
// research call; claim order matches creation order closely enough for load purposes
// and every batch is consumed exactly once.
export function mockProvider(batches: SyntheticLead[][], opts: MockOptions): Provider {
  return {
    async research(): Promise<ResearchResult> {
      await sleep(opts.providerMs)
      const batch = batches.shift() ?? []
      const text = JSON.stringify(batch.map(b => b.lead))
      return { text, citedUrls: batch.map(b => b.lead.source_url) }
    },
    async complete(): Promise<string> {
      await sleep(Math.min(200, opts.providerMs))
      return '[]'
    },
  }
}

export function mockFetchPage(index: Map<string, SyntheticLead>, opts: MockOptions) {
  return async (url: string): Promise<Page> => {
    await sleep(opts.fetchMs)
    const hit = index.get(url)
    return {
      text: hit ? hit.pageText : 'Loadtest wire page. Nothing relevant.',
      title: hit?.pageTitle ?? 'loadtest wire',
      retrievedAt: Math.floor(Date.now() / 1000),
    }
  }
}

// Network fence: any code path that still tries a real fetch during the benchmark
// gets an instant failure instead of touching the internet.
export function fencedFetch(): typeof fetch {
  return (async () => new Response('load harness: network disabled', { status: 503 })) as typeof fetch
}
