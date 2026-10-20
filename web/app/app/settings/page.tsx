import LlmKeyPanel from './llm-key-panel'
import PlanPanel from './plan-panel'

export default function Settings() {
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Settings</h1>
      <p className="text-[#555] text-sm mb-8">Your plan and the AI key your scans run on.</p>
      <PlanPanel />
      <LlmKeyPanel />
      <div className="card p-6 mb-4 opacity-80">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-semibold">Gmail sending</h2>
          <span className="badge">Coming soon</span>
        </div>
        <p className="text-[#555] text-sm">Connect your Gmail to send approved emails from your own inbox. Not available yet.</p>
      </div>
    </div>
  )
}
