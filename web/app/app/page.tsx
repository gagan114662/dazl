import Readiness from './readiness'
import FeatureDiscovery from './feature-discovery'
import FirstRun from './first-run'
import InfoTip from './ui/info-tip'

export default function AppHome() {
  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold tracking-tight">Welcome to dazl</h1>
      <p className="text-[var(--ink-2)] text-sm mt-1 mb-6">Find businesses that need what you sell.<InfoTip>Each lead keeps a public source. You email them from your own Gmail after you approve every word.</InfoTip></p>
      {/* The checklist is at the top for every account, new ones included (above the setup steps); it hides when done. */}
      <Readiness />
      <FirstRun>
        <FeatureDiscovery />
      </FirstRun>
    </div>
  )
}
