# Install the dazl LinkedIn Reader (2 minutes)

1. In dazl, open **Settings > LinkedIn extension** and click **Create token**. Copy it now: it is shown only once.
2. In Chrome, open `chrome://extensions`, switch on **Developer mode** (top right), click **Load unpacked**, and pick the `linkedin-extension` folder of this repo.
3. Click the dazl Reader icon in the toolbar. Paste the token, click **Save**.
4. Stay signed in to LinkedIn in this Chrome. That's it.

What it does: once a minute it asks dazl for a LinkedIn page to read. dazl hands out at most one page at a time, 45 to 180 seconds apart,
40 a day, only 9am to 5pm in your time zone. It opens the page in a background tab, scrolls, reads names, titles and profile links,
sends them to dazl and closes the tab. It never clicks Connect, Message, Like or Follow.

Pause any time with **Pause** in the extension, or in dazl Settings. Revoke the token in dazl Settings to stop it for good.
