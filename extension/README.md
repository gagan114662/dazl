# dazl Connect

A small Chrome extension (Manifest V3). It reads the LinkedIn pages your dazl workspace asks for, in your own browser with your own
LinkedIn sign-in, at a slow pace the dazl server sets. dazl's servers never make a LinkedIn request and never hold a LinkedIn cookie.

## What it does, and nothing else

- **Permissions:** `alarms`, `tabs`, `storage`; host access: `www.linkedin.com` and dazl's own sites. No `cookies` permission.
- **Every minute** it asks the paired workspace (`GET /api/tasks/next`) for one page to read. The server answers with a task or a
  reason to wait: outside the workspace's reading hours (default 09:00-17:00 in its time zone, set in Settings), one page at a time,
  a random 45-180 s pause between pages, the day's cap, a 24 h stop after a LinkedIn security check / 429 / 999, or paused.
- **A task** is one URL and a kind (`company_people`, `profile`, `post_engagement`). It opens it in a background tab, scrolls (no
  clicks), reads names, titles and `/in/` links (`content.js`, parsing in `extract.js`), posts them (`POST /api/tasks/complete`)
  and closes the tab. If LinkedIn shows a sign-in wall or a security check it reports that instead, and the server stops for a day.
- It never connects, messages, likes, follows or posts.

## Pairing

1. dazl Settings asks dazl for a one-time pairing code (10 minutes, single use, bound to the workspace; only a member who may
   configure it) and hands it to the extension through `externally_connectable` (dazl origins only).
2. The extension trades it at `/api/extension/linkedin` for a device token, stored in `chrome.storage.local`.
3. **Disconnect** in Settings revokes the token; the extension forgets it on its next call (401).

## Install (unpacked, until it is in the Chrome Web Store)

1. Download this `extension/` folder.
2. Chrome > `chrome://extensions` > turn on **Developer mode** > **Load unpacked** > pick the folder.
3. Sign in to LinkedIn in that Chrome.
4. dazl > **Settings** > LinkedIn > accept the notice > **Connect LinkedIn**.
