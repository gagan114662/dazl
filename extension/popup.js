// The popup shows whether this browser is connected, to which dazl site, and what it last did. It reads nothing itself.
const $ = id => document.getElementById(id)
const WAIT = { outside_hours: 'outside your reading hours', daily_cap: "today's reads are done", cooldown: 'stopped for a day after LinkedIn asked to slow down', paused: 'paused in dazl Settings', empty: 'nothing to read', pause_between_tasks: 'pausing between pages', one_at_a_time: 'reading a page' }
function show(s) {
  if (s && s.connected) {
    const l = s.last
    const last = !l ? 'Waiting for the first check.' : l.state === 'read' && l.error === 'login_required' ? 'Sign in to LinkedIn in this browser. dazl Connect carries on once you do.' : l.state === 'read' && (l.error === 'challenge' || l.error === 'blocked') ? 'LinkedIn asked for a security check. dazl Connect has stopped for a day.' : l.state === 'read' && l.error ? `Could not read the last page (${l.error}).` : l.state === 'read' ? `Last read: ${l.people} ${l.people === 1 ? 'person' : 'people'}${l.error ? ` (${l.error})` : ''}, ${new Date(l.at).toLocaleTimeString()}.` : l.state === 'waiting' ? `Now: ${WAIT[l.reason] || l.reason}.` : `dazl answered ${l.status}.`
    $('state').textContent = `Connected to ${new URL(s.origin).host}. ${last}`
    $('forget').hidden = false
  } else {
    $('state').textContent = 'Not connected. In dazl, open Settings and click Connect LinkedIn.'
    $('forget').hidden = true
  }
}
chrome.runtime.sendMessage({ type: 'state' }, show)
$('forget').onclick = () => chrome.runtime.sendMessage({ type: 'forget' }, () => show(null))
