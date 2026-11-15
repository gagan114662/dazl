// The dazl Connect browser extension's ID (#1037, F-go step 2), shared by the Settings page (it hands the pairing code to the extension)
// and the tests. The unpacked build's ID is fixed by the public key in extension/manifest.json; the Chrome Web Store assigns its own ID
// when the extension is published, which the operator sets with NEXT_PUBLIC_DAZL_CONNECT_EXTENSION_ID.
export const DEV_EXTENSION_ID = 'epkdepdanldkocmedakfdgnoofgjknfk'
export const CONNECT_EXTENSION_ID = (process.env.NEXT_PUBLIC_DAZL_CONNECT_EXTENSION_ID ?? '').trim() || DEV_EXTENSION_ID
// Where a user gets it. Until the Web Store listing exists (it needs the owner's developer account) this is the unpacked build's
// install page in dazl's own docs.
export const CONNECT_EXTENSION_URL = (process.env.NEXT_PUBLIC_DAZL_CONNECT_EXTENSION_URL ?? '').trim() || 'https://github.com/gagan114662/dazl/tree/main/extension#install'
