export default function AppHome() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
      <p className="text-gray-400 text-sm mb-8">Your GTM agent is watching 30+ signal sources.</p>

      <div className="grid grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Signals found', value: '—' },
          { label: 'Outreach queued', value: '—' },
          { label: 'Replies', value: '—' },
          { label: 'Meetings booked', value: '—' },
        ].map(s => (
          <div key={s.label} className="bg-white/5 border border-white/10 rounded-2xl p-5">
            <div className="text-3xl font-bold">{s.value}</div>
            <div className="text-gray-400 text-sm mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
        <h2 className="font-semibold mb-4">Recent signals</h2>
        <p className="text-gray-500 text-sm">Your agent is scanning. Leads will appear here.</p>
      </div>
    </div>
  )
}
