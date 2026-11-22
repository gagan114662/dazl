const $ = id => document.getElementById(id)
const LABEL = { no_token: 'Paste your token to start.', paused: 'Paused.', token_rejected: 'dazl did not accept this token. Create a new one in dazl Settings.', read: 'Last page read.',
  waiting: 'Waiting for dazl.' }
const WAIT = { outside_hours: 'Reads run 9am to 5pm in your time zone.', daily_cap: 'Done for today (40 pages).', empty: 'Nothing to read right now.', pause_between_tasks: 'Short pause between pages.',
  one_at_a_time: 'Reading a page.', cooldown: 'LinkedIn asked for a check. Reading resumes tomorrow.', paused: 'Paused in dazl Settings.', no_timezone: 'Create the token again in dazl Settings.' }
async function render() {
  const s = await chrome.storage.local.get({ origin: 'https://dazl.ai', token: '', paused: false, status: null })
  $('origin').value = s.origin; $('token').value = s.token
  $('pause').textContent = s.paused ? 'Resume' : 'Pause'
  const st = s.status
  $('st').textContent = st ? `${LABEL[st.state] || ''} ${st.reason ? (WAIT[st.reason] || '') : ''} ${st.state === 'read' ? `${st.people} people.` : ''} (${new Date(st.at).toLocaleTimeString()})` : ''
}
$('save').onclick = async () => {
  const token = $('token').value.trim()
  if (token && !/^dzx_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) { $('st').textContent = 'That is not a dazl extension token.'; return }
  await chrome.storage.local.set({ origin: $('origin').value, token, status: null }); render()
}
$('pause').onclick = async () => { const { paused } = await chrome.storage.local.get({ paused: false }); await chrome.storage.local.set({ paused: !paused }); render() }
chrome.storage.onChanged.addListener(render)
render()
