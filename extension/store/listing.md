# dazl Connect: Chrome Web Store listing

Everything to paste into the developer dashboard. Nothing here is submitted yet.

- Package: `extension/store/dist/dazl-connect-0.2.0.zip` (build with `node extension/store/build.mjs`)
- Visibility: **Unlisted** until the owner says go
- Language: English
- Category: Workflow & Planning

## Store listing tab

**Name** (12 of 75 characters)

```
dazl Connect
```

**Short description** (from the manifest, 128 of 132 characters)

```
Reads the LinkedIn pages your dazl workspace asks for, in this browser with your own LinkedIn sign-in, at a slow pace dazl sets.
```

**Detailed description**

```
dazl Connect links the LinkedIn account you already use in this browser to your dazl workspace, so dazl can show you who to contact at the companies it finds.

HOW IT WORKS
1. Install dazl Connect.
2. In dazl, open Settings and click Connect LinkedIn.
3. That's it. When your workspace needs a LinkedIn page, dazl Connect opens it in a background tab, reads the names, job titles and profile links shown on the page, sends them to your workspace, and closes the tab.

WHAT IT READS
Only the LinkedIn pages your own dazl workspace asks for: company People pages, profiles, and the comments on a post.

WHAT IT NEVER DOES
- It never reads or sends your cookies or your password. It has no cookie permission.
- It never connects, messages, likes, follows or posts.
- It never reads your browsing history or any site other than LinkedIn.
- dazl's servers never sign in to LinkedIn as you. Every read happens in your browser.

A SLOW PACE, SET BY DAZL
dazl Connect reads one page at a time, waits between pages, reads only during your working hours, and stops at a daily cap. If LinkedIn shows a security check or asks to slow down, it stops for a full day.

YOU ARE IN CONTROL
Pause or disconnect in dazl Settings, click "Forget this browser" in the extension, or remove the extension. Any of these stops it at once.

WHO IT IS FOR
dazl Connect only works with a dazl account (https://dazl.ai). It does nothing until you connect it from your own workspace.

LinkedIn limits automated activity on its site. dazl Connect uses your own account at a slow pace and you can pause it at any time, but you use it at your own discretion.
```

**Graphics**

| Asset | File | Size |
|---|---|---|
| Store icon | `extension/icons/128.png` | 128x128 |
| Screenshot 1 | `extension/store/screenshots/1-connect.jpg` | 1280x800 |
| Screenshot 2 | `extension/store/screenshots/2-reads-in-your-browser.jpg` | 1280x800 |
| Screenshot 3 | `extension/store/screenshots/3-slow-pace.jpg` | 1280x800 |
| Small promo tile | `extension/store/screenshots/promo-tile-440x280.jpg` | 440x280 |

The popup in each screenshot is the real popup of the packaged build, captured in Chromium with sample state. A fourth screenshot of dazl Settings showing the connected account should be added once that screen is final.

**Links**

- Homepage: `https://dazl.ai`
- Support: `https://dazl.ai` (owner to confirm a support email)

## Privacy tab

**Single purpose**

```
dazl Connect reads the LinkedIn pages a user's own dazl workspace asks for, in the user's browser with the user's own LinkedIn sign-in, and sends the names, job titles and profile links shown on those pages to that workspace.
```

**Permission justifications**

`alarms`

```
Wakes the extension once a minute to ask the user's dazl workspace whether there is a LinkedIn page to read. Manifest V3 service workers do not stay running, so an alarm is the only reliable way to do this. The workspace decides the pace and usually answers "wait".
```

`storage`

```
Stores, on the device only, the dazl site this browser is paired with, the device token that identifies it to that workspace, and a short note of the last action so the popup can show status. Nothing else is stored.
```

Host permission `https://www.linkedin.com/*`

```
The extension's single purpose is to read LinkedIn pages the user's workspace asks for. A content script on www.linkedin.com reads the names, job titles and profile links already shown on the page the extension opened. It only scrolls; it never clicks, types, connects, messages, likes or posts. It reads no page unless the extension itself opened it for a task.
```

Host permissions `https://dazl.ai/*` and `https://www.dazl.ai/*`

```
These are dazl's own sites. The extension asks them for the next page to read and sends the result back, authenticated with the device token. They are also the only pages allowed to pair the extension (externally_connectable).
```

**Remote code**

```
No. All code is in the package. The extension loads no remote scripts and evaluates no strings as code.
```

**Data usage**

Tick:
- Personally identifiable information (names, job titles and LinkedIn profile links of people shown on the pages read)
- Website content (the text of the LinkedIn pages read, limited to those fields)

Do not tick: health, financial, authentication information, personal communications, location, web history, user activity.

Certify all three:
- Data is not sold or transferred to third parties outside the approved use cases.
- Data is not used or transferred for purposes unrelated to the item's single purpose.
- Data is not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL**

```
https://dazl.ai/privacy
```

## Distribution tab

- Visibility: **Unlisted**
- Regions: all
- Pricing: free

## Test instructions for the reviewer

The reviewer cannot test without a dazl account. Before submitting, create a reviewer account and paste:

```
1. Sign in at https://dazl.ai with: <reviewer email> / <reviewer password>
2. Sign in to any LinkedIn account in the same browser.
3. In dazl, open Settings > LinkedIn and click Connect LinkedIn. The extension popup then shows "Connected to dazl.ai".
4. Run a play. Within a few minutes the extension opens one LinkedIn page in a background tab, reads it and closes it. The popup shows "Last read: N people".
```

## Before clicking "Submit for review"

1. The live privacy page still says "DRAFT - not yet approved" and has open placeholders. The extension section is written (`web/lib/legal/policy.ts`) but not deployed. Approve the policy and deploy it first.
2. The server side this version talks to (`/api/tasks/next`, `/api/tasks/complete`, the Settings pairing screen) is not deployed. A reviewer following the test steps would find nothing happens. Deploy it and prove one real connected account end to end first.
3. After the first upload the store assigns an extension ID. Set `NEXT_PUBLIC_DAZL_CONNECT_EXTENSION_ID` to it and redeploy, or Settings will look for the developer build's ID.
4. Create the reviewer account for the test instructions.
