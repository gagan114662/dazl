export interface UiSources { github: boolean; youtube: boolean; v2ex: boolean; jobboards: boolean; feedText: string; pageText: string; advPick: string[] }
const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)
// The `sources` object the scan form sends. Nothing ticked sends nothing (the default scan is unchanged).
export function buildSources(o: UiSources): Record<string, unknown> | null {
  if (!(o.github || o.youtube || o.v2ex || o.jobboards || o.feedText.trim() || o.pageText.trim() || o.advPick.length)) return null
  return { adapters: [...(o.github ? ['github'] : []), ...(o.youtube ? ['youtube'] : []), ...(o.v2ex ? ['v2ex'] : []), ...(o.feedText.trim() ? ['rss'] : []), ...(o.pageText.trim() ? ['web'] : []), ...(o.jobboards ? ['jobboards'] : [])], feeds: lines(o.feedText), pages: lines(o.pageText), advanced: o.advPick }
}
