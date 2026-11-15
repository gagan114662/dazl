// The popup shows whether this browser is connected and to which dazl site; it can re-sync or forget. It reads nothing itself.
const $ = id => document.getElementById(id)
function show(s) {
  if (s && s.connected) {
    $('state').textContent = `Connected${s.name ? ` as ${s.name}` : ''} to ${new URL(s.origin).host}${s.synced_at ? `, synced ${new Date(s.synced_at).toLocaleString()}` : ''}.`
    $('sync').hidden = false; $('forget').hidden = false
  } else {
    $('state').textContent = 'Not connected. In dazl, open Settings and click Connect LinkedIn.'
    $('sync').hidden = true; $('forget').hidden = true
  }
}
chrome.runtime.sendMessage({ type: 'state' }, show)
$('sync').onclick = () => chrome.runtime.sendMessage({ type: 'sync' }, r => { $('state').textContent = r && r.ok ? `Synced${r.name ? ` as ${r.name}` : ''}.` : (r && r.error) || 'Could not sync.' })
$('forget').onclick = () => chrome.runtime.sendMessage({ type: 'forget' }, () => show(null))
