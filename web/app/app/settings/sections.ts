// The section links at the top of /app/settings (#1192). Every id must be an element id somewhere on the page (a nav link to an
// id nothing carries scrolls nowhere); test/settings-sections-1192.test.ts holds that. "competitors" had its panel on the page
// (competitors-panel.tsx, id="competitors") but no link.
export const SETTINGS_SECTIONS: readonly (readonly [string, string])[] = [
  ['plan', 'Plan'], ['account', 'Account'], ['team', 'Team'], ['devices', 'Devices'], ['memory', 'Memory'], ['model-key', 'Model key'],
  ['competitors', 'Competitors'], ['connectors', 'Connectors'], ['enrichment', 'Enrichment'], ['gmail', 'Gmail'], ['autopilot', 'Autopilot'], ['replies', 'Replies'],
]
