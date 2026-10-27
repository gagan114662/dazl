// Pure strings (no Node imports): bundled into the leads page and used by the API and CSV.
export const COPY_ORIGIN = 'tinyfish_copy' as const

// What the user, the API and the CSV say about a lead verified from a copy. Never "read on the page by dazl".
export function evidenceOriginLabel(origin: string | null | undefined, ownFailure: string | null | undefined): string {
  if (origin !== COPY_ORIGIN) return ''
  return `Checked against a copy of the page fetched by TinyFish. dazl's own fetch of the page failed (${ownFailure || 'unknown'}), so dazl did not read the page directly.`
}
