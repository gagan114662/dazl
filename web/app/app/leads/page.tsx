export default function Leads() {
  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">Leads</h1>
          <p className="text-gray-400 text-sm">Buyers showing purchase intent right now, with cited signals.</p>
        </div>
        <button className="bg-indigo-500 hover:bg-indigo-400 px-5 py-2 rounded-xl text-sm font-medium transition">
          Run scan now
        </button>
      </div>

      <div className="flex gap-2 mb-6">
        {['All', 'New', 'Contacted', 'Replied', 'Booked', 'Paid'].map(tab => (
          <button key={tab} className={`px-4 py-1.5 rounded-lg text-sm transition ${tab === 'All' ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white'}`}>
            {tab}
          </button>
        ))}
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl divide-y divide-white/5">
        <div className="p-6 text-center text-gray-500 text-sm py-16">
          <p className="text-lg font-medium text-gray-400 mb-2">No leads yet</p>
          <p>Your agent is scanning 30+ sources. Leads appear here with their signal and reason.</p>
          <button className="mt-4 bg-indigo-500 hover:bg-indigo-400 px-6 py-2 rounded-xl text-sm font-medium transition">
            Run first scan
          </button>
        </div>
      </div>
    </div>
  )
}
