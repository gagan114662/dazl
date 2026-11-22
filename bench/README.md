# Benchmark

The one measure of progress: how many good leads a real request returns.

- `prompts.json`: 16 fixed prompts. 12 open web (8 countries, 7 non-tech industries; hiring, funding, new leadership, expansion) and 4 LinkedIn.
- `results/`: one table per run. Tables hold counts only. The repo is public, so lead and contact data are never committed here.

## Run

```
cd web && npm run bench                 # all 16, at most US$1 each
cd web && npm run bench -- --cases toronto-dental-expanding,london-fintech-funding
cd web && npm run bench -- --dry        # no network, shows the plan and missing keys
```

It runs every prompt through the real scan path (`createQueryJob -> runJob`) on a throwaway in-memory store, with real search and model calls. Keys: `TINYFISH_API_KEY` and one of `MATRIX_ANTHROPIC_KEY`, `SCOREBOARD_ANTHROPIC_KEY`, `DAZL_TRIAL_ANTHROPIC_KEY`.

## Columns

`cand` candidates found, `leads` listed, `ready` companies the product shows as ready, `domain%`, `named%`, `dated%` (a proven event day with a source URL), `secs`, `usd`.

## Rule

Every PR posts the table before and after its change. A PR that does not move the numbers or protect them does not merge. The only exceptions are launch-safety work (backups, alerts, isolation).

## Launch bar

- At least 5 ready on at least 13 of 16 prompts.
- At least 70% named and 100% dated among shown leads.
- Under US$1 per prompt.
