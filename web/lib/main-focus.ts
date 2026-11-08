// #673: the decision behind app/app/main-focus.tsx, kept free of React and the DOM so it can be unit-tested.
// `last` is the element in <main> that had focus most recently (or <main> itself).

/** Focus fell to the document (BODY or nothing) because the node in <main> that had it was removed from the page. */
export function shouldRestoreMainFocus(active: unknown, body: unknown, last: { readonly isConnected: boolean } | null, pointerSince: boolean): boolean {
  return (active === null || active === body) && last !== null && !last.isConnected && !pointerSince
}
