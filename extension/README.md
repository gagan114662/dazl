# dazl Connect

A small Chrome extension (Manifest V3) that connects the LinkedIn account you are signed in to in your browser to your dazl
workspace, in one click. No cookie is ever copied or pasted by hand.

## What it does, and nothing else

- **Single purpose:** sign your dazl workspace in to LinkedIn with the session you already have in this browser.
- **What it reads:** exactly two cookies of `linkedin.com`, `li_at` and `JSESSIONID`. It reads no history, no tabs, no page
  content and no other site (`permissions`: `cookies`, `storage`; host access: `linkedin.com` and dazl's own sites).
- **Where it sends them:** only to the dazl site that paired it (`https://dazl.ai` or `https://staging.dazl.ai`), over HTTPS, with
  a device token. dazl stores the session encrypted for your workspace and uses it only for the LinkedIn reads you switch on.
- **When:** once when you click **Connect LinkedIn** in dazl Settings, and again whenever LinkedIn rotates either cookie, so the
  connection does not silently stop working.
- **Stopping it:** **Disconnect** in dazl Settings revokes the device and deletes the stored session; the extension forgets it on
  its next sync. "Forget this browser" in the extension's popup does the same on this side. Removing the extension stops it.

## How the pairing works

1. dazl Settings asks dazl for a one-time pairing code (10 minutes, single use, bound to your workspace; only a member who may
   configure the workspace, after the LinkedIn risk notice was accepted).
2. The page hands the code to the extension (only dazl's own pages can message it: `externally_connectable`).
3. The extension trades the code at that same dazl site for a device token, then sends the two cookies with it.
4. dazl names the account once (one read of your own LinkedIn profile) and shows **Connected as &lt;name&gt;**.

The device token stops working at once if the member who paired it leaves the workspace or loses the right to configure it.

## Install

Until the Chrome Web Store listing is published, load it unpacked:

1. Download this folder (`extension/`).
2. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and pick the folder.
3. Sign in to LinkedIn in the same browser, then in dazl open **Settings → Connectors → LinkedIn** and click **Connect LinkedIn**.

The unpacked build's ID is fixed by the public key in `manifest.json` (`epkdepdanldkocmedakfdgnoofgjknfk`); dazl's Settings page
talks to that ID unless the operator sets `NEXT_PUBLIC_DAZL_CONNECT_EXTENSION_ID` (the Web Store assigns its own ID).

## Chrome Web Store listing (prepared, not published)

- **Name:** dazl Connect
- **Single purpose:** Connects the LinkedIn account signed in to this browser to the user's dazl workspace.
- **Permission justifications:**
  - `cookies`: read the `li_at` and `JSESSIONID` cookies of linkedin.com, the only data the extension handles.
  - `storage`: keep the device token and the paired dazl site, so a cookie rotation can be re-sent.
  - Host `linkedin.com`: needed to read those two cookies. Hosts `dazl.ai`, `staging.dazl.ai`: the only places they are sent.
- **Data use disclosure:** handles "authentication information" (the LinkedIn session); sent only to dazl, for the user's own
  workspace; not sold, not used for anything else, not shared with third parties.
- **Privacy text:** see `PRIVACY.md`.
- **Icons:** `icons/16.png`, `icons/48.png`, `icons/128.png`. The store also needs one 1280x800 screenshot (Settings showing
  "Connected as ..."), taken from the published app.

Publishing needs the owner's Chrome Web Store developer account (a one-time US$5 fee).
