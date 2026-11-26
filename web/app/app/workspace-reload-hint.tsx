'use client'

import { useEffect, useState } from 'react'

export default function WorkspaceReloadHint() {
  const [showHint, setShowHint] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShowHint(true), 10000)
    return () => clearTimeout(timer)
  }, [])

  return showHint
    ? <p className="mt-1 text-sm text-[var(--ink-2)]">If this screen stays here, reload the page to try again.</p>
    : null
}
