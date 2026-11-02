// Port selection for browser-driven UI tests. Chrome refuses to navigate to a list of "unsafe" ports
// (Chromium's kRestrictedPorts, net/base/port_util.cc) with net::ERR_UNSAFE_PORT, so a random ephemeral
// port that lands on one flakes the whole UI leg (seen live: 3659 blocked at leads-research-review).
// Pick inside the harness's usual range but never a restricted port. The list is Chromium's full
// restricted set, not the one port that happened to fail: any of them breaks page.goto the same way.
export const CHROMIUM_RESTRICTED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
])
export function pickUiPort(lo = 3300, span = 500) {
  for (;;) {
    const p = lo + Math.floor(Math.random() * span)
    if (!CHROMIUM_RESTRICTED_PORTS.has(p)) return p
  }
}
