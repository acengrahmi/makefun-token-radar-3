# Launch Radar — token-radar-01 entry (model radar-4)

Ranks the snapshot's pre-token protocols by the value their token launch
would plausibly reach, prices them with a law fitted on the launches that
already happened, and grades its own accuracy in public.

## The model in one paragraph

On the 128 protocols in the snapshot whose tokens already trade, market cap
does not grow in proportion to TVL: fitting `log(cap) = a + b·log(TVL) +
category offset` gives b ≈ 0.52, so doubling TVL multiplies the expected cap
by about 1.44, not 2. Each pre-token protocol is priced by that law — its
category offset shrunk toward zero (k = 6) so thin categories lean on the
global fit — times three printed adjustments for 7-day growth, age and chain
reach. The stated range is not a fudge factor: it is the model's own
leave-one-out residual band for that category. At build time the program
re-runs the full leave-one-out audit on all 128 launches for both this law
and the previous median-multiple model, and publishes both scorecards, plus
every comparable's individual prediction, in the dashboard's data.

## What it writes

- `board.json` — 197 rows: slug, name, rank, `implied_value_usd`, the honest
  band (`low_usd`/`high_usd`), fitted multiple, audit score, confidence grade
  (A/B/C by evidence depth), component percentiles, written reasons, risk
  flags, and an 8-step farm plan with plan totals (capital band, weekly
  minutes, hold days).
- `data.js` — the same board plus the fitted law, both backtest scorecards
  (all launches, and the 88 board-like launches alone), the category offset
  table, and all 128 comparables with their leave-one-out predictions.
- `dashboard/` — Board (sortable, filterable, per-row range whiskers on a
  shared log scale), a per-protocol detail view, Comparables (the evidence
  and the audit), and Method (the law, the score, the eligibility rule, and
  the honesty notes). No network, no external assets.
- `screenshots/` — the board, the #1 protocol's detail, and a filtered view,
  rendered from this build.
- `dossier.json` — written by the kit's `buildDossier`, unmodified.

## Run it

```
node main.ts --input <snapshot.json or its directory>
```

Node 22+, standard library only. Two runs over the same snapshot produce
byte-identical output. `tools/backtest.mjs` holds the offline model search
that selected this law (five estimator families, ablations, subset audits);
`tools/validate.mjs` re-checks a built `out/` tree against the gate's rules
independently of the model.
