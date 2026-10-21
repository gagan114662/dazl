import LlmKeyPanel from './llm-key-panel'
import PlanPanel from './plan-panel'
import AdvancedPanel from './advanced-panel'
import GmailPanel from './gmail-panel'
import AutopilotPanel from './autopilot-panel'
import RepliesPanel from './replies-panel'
import CrmPanel from './crm-panel'

const SECTIONS = [['plan', 'Plan'], ['model-key', 'Model key'], ['connectors', 'Connectors'], ['gmail', 'Gmail'], ['autopilot', 'Autopilot'], ['replies', 'Replies']]

export default function Settings() {
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Settings</h1>
      <p className="text-[#555] text-sm mb-4">Your plan, your AI key and optional connectors.</p>
      <nav aria-label="Settings sections" className="flex flex-wrap gap-x-5 gap-y-1 mb-6 text-xs font-mono uppercase tracking-wider">
        {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className="underline underline-offset-4 text-[#111]">{label}</a>)}
      </nav>
      <div id="plan" className="scroll-mt-6"><PlanPanel /></div>
      <div id="model-key" className="scroll-mt-6"><LlmKeyPanel /></div>
      <AdvancedPanel />
      <div id="gmail" className="scroll-mt-6"><GmailPanel /></div>
      <div id="autopilot" className="scroll-mt-6"><AutopilotPanel /></div>
      <div id="replies" className="scroll-mt-6"><RepliesPanel /></div>
      <div id="crm" className="scroll-mt-6"><CrmPanel /></div>
    </div>
  )
}
