import Readiness from './readiness'
import FirstRun from './first-run'
import Journey from './journey'
import FeatureDiscovery from './feature-discovery'
import InfoTip from './ui/info-tip'

// One Home for new and returning accounts: onboarding until dazl knows the business, then the journey (what dazl
// understands, the one next action, the current play's opportunities). Setup details stay secondary and collapsed.
export default function AppHome() {
  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold tracking-tight">Welcome to dazl</h1>
      <p className="text-[var(--ink-2)] text-sm mt-1 mb-6">Find businesses that need what you sell.<InfoTip>Each lead keeps a public source. You email them from your own Gmail after you approve every word.</InfoTip></p>
      <FirstRun>
        <Journey />
        <details className="drawer card mt-4" data-testid="setup-details">
          <summary><span className="flex items-center gap-2">Setup details and all plays</span><span className="ml-auto text-xs font-normal text-[var(--ink-3)] hidden sm:inline">AI key, sources, Gmail, sender, limits</span></summary>
          <div className="px-5 pb-5 pt-4 border-t border-[var(--line)]"><Readiness /><FeatureDiscovery /></div>
        </details>
      </FirstRun>
    </div>
  )
}
