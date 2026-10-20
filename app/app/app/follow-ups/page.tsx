export default function FollowUps() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-1">Follow-ups</h1>
      <p className="text-gray-400 text-sm mb-8">Automated 3-step sequences. Stops the moment they reply.</p>

      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-6">
        <h2 className="font-semibold mb-4 text-sm text-gray-300 uppercase tracking-wider">Sequence settings</h2>
        <div className="grid grid-cols-3 gap-6">
          {[
            { label: 'Follow-up 1', days: '3 days after first email' },
            { label: 'Follow-up 2', days: '7 days after first email' },
            { label: 'Follow-up 3', days: '14 days after first email' },
          ].map(s => (
            <div key={s.label} className="flex flex-col gap-1">
              <div className="font-medium">{s.label}</div>
              <div className="text-gray-400 text-sm">{s.days}</div>
              <div className="flex items-center gap-2 mt-2">
                <div className="w-8 h-4 bg-indigo-500 rounded-full" />
                <span className="text-xs text-gray-400">Enabled</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 text-center text-gray-500 text-sm py-16">
        <p className="text-lg font-medium text-gray-400 mb-2">No follow-ups scheduled</p>
        <p>Follow-ups are queued automatically when outreach is sent.</p>
      </div>
    </div>
  )
}
