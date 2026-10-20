import LlmKeyPanel from './llm-key-panel'
import PlanPanel from './plan-panel'
import ConnectorsPanel from './connectors-panel'
import AdvancedPanel from './advanced-panel'

export default function Settings() {
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Settings</h1>
      <p className="text-gray-400 text-sm mb-8">Your plan and the AI key your scans run on.</p>
      <PlanPanel />
      <LlmKeyPanel />
      <ConnectorsPanel />
      <AdvancedPanel />
      <div className="card p-6 mb-4 opacity-80">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-semibold">Gmail sending</h2>
          <span className="badge">Coming soon</span>
        </div>
        <p className="text-gray-400 text-sm">Connect your Gmail to send approved emails from your own inbox. Not available yet.</p>
      </div>
    </div>
  )
}
