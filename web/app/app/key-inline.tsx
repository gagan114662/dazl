'use client'

// #1703: bring-your-own-key is finished. No customer is asked for an AI key anywhere: searches run on dazl's own keys and
// count against the free searches or the plan. This stays only so readiness.tsx and first-run.tsx keep compiling until their
// pending changes (#1880, #1879) land; the follow-up deletes it and its callers. It renders nothing and never calls the key route.
export default function KeyInline(_props: { reason: string; onSaved: () => void }) {
  return null
}
