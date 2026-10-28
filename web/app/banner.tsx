"use client"
import { useState } from 'react'

export default function Banner() {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <div className="bg-[#f8e5d4] text-[13px] text-[#2c002a]">
      <div className="max-w-6xl mx-auto px-6 py-2 flex items-center justify-center gap-3 relative">
        <span className="text-center pr-6">dazl is now in beta. Find leads with the evidence behind them, then reach them from your own Gmail. <a href="/api/auth/google" className="underline underline-offset-2 font-semibold">Get early access</a></span>
        <button type="button" aria-label="Dismiss announcement" onClick={() => setOpen(false)} className="absolute right-4 top-1/2 -translate-y-1/2 text-[#555] hover:text-[#111] text-lg leading-none px-1">×</button>
      </div>
    </div>
  )
}
