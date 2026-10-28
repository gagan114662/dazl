'use client'
import { useState, type ReactNode } from 'react'

// The (i) next to a short line: every caveat and factual limit lives here, word for word. It opens on hover, keyboard
// focus or click (touch), and the text stays in the page for screen readers (aria-describedby).
let seq = 0
export default function InfoTip({ children, label = 'More information' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  const [id] = useState(() => `tip-${++seq}`)
  return (
    <span className="infotip ml-1" data-open={open ? 'true' : 'false'} data-testid="infotip" onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-describedby={id} aria-expanded={open} onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>i</button>
      <span role="tooltip" id={id} data-testid="infotip-text">{children}</span>
    </span>
  )
}
