// Prev/next navigation for the Leads side panel (#1038, PR 2 of 3). Dependency-free on purpose:
// tests import this file directly without pulling in the component tree.

// The id one step from `current` in `ids` (the visible, sorted order). Clamps at the ends:
// past either edge there is no next row and the caller disables the button instead.
export function adjacentLeadId(ids: string[], current: string, dir: 1 | -1): string | null {
  const i = ids.indexOf(current)
  if (i < 0) return null
  const j = i + dir
  return j >= 0 && j < ids.length ? ids[j] : null
}
