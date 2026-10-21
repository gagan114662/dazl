import LlmKeyPanel from './llm-key-panel'
import PlanPanel from './plan-panel'
import ConnectorsPanel from './connectors-panel'
import GmailPanel from './gmail-panel'
import AutopilotPanel from './autopilot-panel'

export default function Settings() {
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Settings</h1>
      <p className="text-[#555] text-sm mb-8">Your plan and the AI key your scans run on.</p>
      <PlanPanel />
      <LlmKeyPanel />
      <ConnectorsPanel />
      <GmailPanel />
      <AutopilotPanel />
    </div>
  )
}
