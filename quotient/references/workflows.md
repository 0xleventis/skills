<!-- GENERATED from public/skill/references/workflows.md — edit there, then npm run skill:build -->

# Quotient Agent Workflows

The a–g playbook: which endpoint(s) to call, in what order, how to read the fields, and how to
hand execution off to Bankr. Quotient supplies intelligence; Bankr executes trades. Scripts and
docs here never place trades directly.

**Setup for every Quotient call**

```bash
BASE="${QUOTIENT_BASE_URL:-https://quotient-api-gateway.onrender.com}"
MAX_PAYMENT="${QUOTIENT_MAX_PAYMENT_USD:-0.10}"
qget() { bankr x402 call "$1" --max-payment "$MAX_PAYMENT" --yes --raw; }
# The examples use Bankr's x402 payer. See vanilla-x402-flow.md for another wallet client.
```

Prices are discovered at `GET $BASE/api/public/pricing` and in `/openapi.json`
(`x-payment-info`); the runtime `402` challenge is authoritative. Do not hardcode prices.

**Signal status vocabulary** (used throughout): `actionable` (live, eligible) ·
`unconfirmed` (Q's latest forecast flipped side vs prior — awaiting confirmation) ·
`paused` (temporarily unavailable after a deep open-loss drawdown, venue divergence, or safety veto) ·
`done` (converged: `converge_upside_pct <= 0`) · `retired` (terminal, with `retired_reason`
one of `resolved | flipped | fading_q | expired`).

**Bankr execution handoff** (used by several workflows; always slug, never question text):

Before emitting either prompt, run `./scripts/pm.sh book <slug>` and give the user a
liquidity preflight: proposed USD size; current Q-side cost and pricing timestamp; API
`capacity_usd_at_2c`, `capacity_basis`, and `capacity_as_of`; proposed size as a percentage
of known capacity; and the current bid/ask, spread, and 2-cent depth. State plainly that
capacity is near-touch depth, not a guaranteed fill or exact impact estimate, and that a
market order may walk the book. If the snapshot is stale/unknown, uses `volume-fallback`, or
the order is material relative to live depth, ask the user to reduce size, use a limit order
when supported, or explicitly accept the slippage risk before handing off the trade.

```
bankr prompt "Bet $25 on <Yes|No> for <slug> on Polymarket"
bankr prompt "Sell my <Yes|No> position on <slug> on Polymarket"
```

All position reads below are advisory. Standing disclaimer, repeat it in output:
"Informational reads derived from Quotient's forecast — not trade instructions."

---

## a. Portfolio — "what's new with my wallet"

**When:** the user asks what changed across their Polymarket positions. One call — the server
joins live Polymarket positions to Quotient coverage.

```bash
qget "$BASE/api/v1/portfolio?wallet=0xYourWallet"
# optional: &size_threshold=1  &include_perps=true (adds perps positions + oil_signal annex)
```

Each position carries a `quotient` block: `{covered, market, forecast, signal, convergence}`.
Present in this order:

1. **Q is against you** — `quotient.covered && quotient.convergence.aligned == false`. Q's side
   (`convergence.q_side`) opposes your position. Call these out first.
2. **Forecast moved** — `quotient.forecast.delta_from_prior != 0`. The portfolio block has the
   delta, `refresh_reason`, and `bluf`; when the user wants the *why*, fetch
   `GET /api/v1/markets/{slug}/forecast` and quote `delta_reasoning` verbatim (it is a
   precomputed deterministic sentence).
3. **Thesis played out** — `quotient.signal.status == "done"` (or
   `convergence.distance_to_convergence_cents <= 0`). Converged; advisory exit-candidate.
4. Close with `unmatched_count` — "N positions Quotient doesn't cover."

Errors: bad wallet → `422`; Polymarket data-api down → `502 upstream_unavailable` (fail-closed,
never a partial list — retry with backoff, see error-handling.md).

Handoff for any exit-candidate: `bankr prompt "Sell my <Yes|No> position on <slug> on Polymarket"`.

## b. Discovery — "what markets does Quotient have about X"

**When:** topic search. The API has **no free-text search** — do not pretend it does.

1. If X plausibly matches a category, try the cheap path first:

```bash
qget "$BASE/api/v1/markets?topic=X&limit=50"
```

2. No/weak matches → paginate the catalog and grep `question` + `slug` locally
   (case-insensitive). Each page is a **paid call** — bound the loop (~10 pages):

```bash
CURSOR=""
while :; do
  RESP=$(qget "$BASE/api/v1/markets?limit=50${CURSOR:+&cursor=$CURSOR}")
  echo "$RESP" | jq -r '.markets[] | [.slug, .question] | @tsv' | grep -i "X"
  CURSOR=$(echo "$RESP" | jq -r '.next_cursor // empty'); [ -z "$CURSOR" ] && break
done
```

Cursors are opaque and bound to endpoint + sort + filters; reusing one with changed filters
returns `422 invalid_cursor` — restart without the cursor. Other useful params:
`max_forecast_age` (hours), `changed_within` (hours — only markets whose latest forecast is
that fresh), `sort`.

3. Present matches with `market_odds`, `latest_forecast_at`, `latest_forecast_delta`,
   `signal_count`, `polymarketUrl`.

Convenience wrapper: `./scripts/quotient.sh markets [--grep "pattern"] [--topic T] [--json]`.

## c. Single market — "what's new with this market"

**When:** drill into one market. Two calls.

```bash
qget "$BASE/api/v1/markets/{slug}/forecast?history=3"
qget "$BASE/api/v1/sources?markets={slug}&window=48"
```

Forecast read: `probability`, `created_at`, and the change primitives `delta_from_prior`,
`delta_reasoning`, `prior_forecast_id`, `refresh_reason`, `refresh_triggered_by`.
`refresh_reason != null` means the forecast **reran on an event trigger** (e.g. a price move),
not just the schedule. Flag when `|delta_from_prior| >= 0.05`. `history[]` gives the prior
versions for a delta chain. Known market with no forecast yet → `forecast: null` + `message`.

Sources read (batch endpoint — `markets` takes 1–10 comma-separated slugs; `window` in hours,
default 48; `types=article,x_post`): present the top ~5 rows with `title`, `source_name`,
`feed_tier`, `published_at`, and `relevance.reasoning` / `relevance.evidence_quote` when
present; X rows carry `author_handle` + `is_expert`.

Synthesis template:

> "Q moved `<delta_from_prior>` to `<probability>` (`<delta_reasoning>`). Trigger:
> `<refresh_reason || 'scheduled'>`. New since then: `<top sources>`."

Multi-market variant: pass several slugs to `/api/v1/sources?markets=a,b,c` in one call; loop
the forecast endpoint per slug.

## d. Price / position helpers (keyless)

Live Polymarket prices, order-book depth, wallet positions, perps, and Hyperliquid reads are
all **keyless external calls** — no Quotient spend. Full commands, field lists, and gotchas:
`references/polymarket-monitoring.md` (wrapped by `./scripts/pm.sh`). Use these as the fast
path between paid Quotient calls (see Polling cadence below).

## e. Equal-weight signal strategy — `scripts/signal-strategy.mjs`

**When:** deploy a budget across active signals with recent forecast updates, equal-weight, capacity-aware.

```bash
node scripts/signal-strategy.mjs --wallet 0xYourWallet --budget 100 \
  [--min-conviction 2] [--status actionable] [--min-capacity 500] \
  [--max-positions 5] [--window 24] [--json] [--execute]
```

The engine fetches `GET /api/v1/signals?window=24&status=actionable` and filters:

- **one call per market** — the API selects the newest published signal for each market
  before applying side/status filters. It never falls back to an older signal when the newest
  call is ineligible.
- **time context** — `window` applies to `forecast_updated_at`, not `published_at`. Use
  `is_new_today` to distinguish a new publication from an older active signal refreshed by Q;
  `is_fresh` marks forecast updates no more than six hours old.
- **status** — default `actionable` only. Drops `unconfirmed` (flip-veto), `done` (converged —
  nothing left to buy), `paused`, `retired`.
- **conviction** — `conviction_tier` 1–3 (3 = tightest forecast ensemble; label mirror in
  `conviction`: high/medium/low). `--min-conviction N` drops lower tiers; `has_band` is
  `false` only when no conviction read could be computed at all (missing Q or price) —
  pre-ensemble inferred reads still report `true` with tier capped at 2 (an inferred read,
  not a measured dispersion band).
- **upside** — drops `converge_upside_pct <= 0`.
- **capacity gate** — `capacity_usd_at_2c` is near-touch order-book depth (basis
  `capacity_basis: "depth-2c"`, timestamp `capacity_as_of`). When it is `null`, rows are kept
  only on the volume fallback (`capacity_basis: "volume-fallback"`, i.e. `market.volume_24h`
  cleared the server floor); `--min-capacity` gates on the known dollar figure.
- **idempotency** — never re-buys: checks the wallet's held set (data-api) and a local state
  file of already-emitted prompts.

Sizing: `min(budget / n, 0.10 × capacity_usd_at_2c)` — never more than 10% of near-touch depth;
uncapped only on volume-fallback rows.

**Dry-run first, always.** Without `--execute` the script only prints the plan and `DRY-RUN>`
prompt lines and writes no state. Review the plan, then either run the emitted
`bankr prompt "Bet $<amt> on <Yes|No> for <slug> on Polymarket"` lines yourself or rerun with
`--execute` (requires `BANKR_API_KEY`; submits via the Bankr Agent API and polls each job).
The plan reports size and capacity and warns about price impact. Immediately before approval,
re-read `./scripts/pm.sh book <slug>`; the persisted capacity snapshot is not a substitute for
the live order book or the venue's final execution preview.

## f. Featured signal

**When:** "what's Quotient's top pick right now." The server picks — never re-implement or
substitute a stale pick.

```bash
qget "$BASE/api/v1/signals/featured"
```

Response: `{signal, featured_by, message?}`. `featured_by: "pin"` = an operator-pinned signal
(honored unless its status has gone bad); `"auto"` = server ranking over active signals whose
latest forecast update is inside the 24-hour window and which are `actionable`, live-priced,
and clear volume/expiry floors (freshest publish day →
conviction → upside). `signal: null` → say "no featured signal clears the bar right now" and
stop.

Present: `market.question`, `side` ("Q → YES/NO"), `entry_cost_cents` vs `current_cost_cents`
(Q-side cents), `converge_upside_pct` — **hide the upside figure when <= 0** (the converged
display rule; the thesis has played out), `conviction` / `conviction_tier`, and
`market.polymarketUrl`. `resolves_in_window: true` means the convergence goal is a full win
(100 cents) rather than Q's value.

Offer the handoff: `bankr prompt "Bet $25 on <Yes|No> for <market.slug> on Polymarket"`.

## g. Convergence monitor — `scripts/converge-monitor.sh`

**When:** recurring hold-or-sell read over a wallet.

```bash
./scripts/converge-monitor.sh 0xYourWallet [--json] [--oil]
```

One `GET /api/v1/portfolio?wallet=` call; per covered position the `quotient.convergence`
block gives `q_side`, `aligned`, `q_value_cents`, `current_cost_cents`,
`distance_to_convergence_cents`, `converge_upside_pct`, `priced_at`, and `quotient.signal`
gives `status` / `retired_reason`. Advisory vocabulary (print the standing disclaimer):

| Read | Rule |
|---|---|
| **HOLD** | `aligned` && signal status `actionable` && `distance_to_convergence_cents > 0` |
| **WATCH** | status `unconfirmed`; or pricing not live (`live_priced: false` on `/v1/signals` reads, stale `priced_at` on portfolio reads); or the oil reading is `reading_missing` / `degraded` / not `is_current` |
| **EXIT-CANDIDATE** | status `done` or `paused`; or `!aligned` (Q opposes your side); or `retired_reason == "flipped"` |
| **NO-COVERAGE** | `quotient.covered == false` — listed, never scored |

For each EXIT-CANDIDATE print the handoff:
`bankr prompt "Sell my <Yes|No> position on <slug> on Polymarket"`.

## Oil (WTI) — signal + both venues

**When:** the user holds or is considering WTI perps exposure; also runs as
`converge-monitor.sh --oil`.

```bash
qget "$BASE/api/v1/signals/oil?include_marks=true"
```

Response: `reading` (frozen daily read: `reading_date`, `is_current`, `days_since_reading`,
`state` bullish/bearish, `side` long/short, `z`, `gap`, `intensity`, `headline`, `summary`),
`episode` (`status` open/closed, `ref_price`, `return_pct`, `live_return_pct`), `marks`
(`polymarket_perps` WTIOIL-USD mark/index/funding_rate + `hyperliquid` xyz:CL mid), `degraded`,
`reading_missing`.

Then read positions on **both venues** (keyless, exact commands in
polymarket-monitoring.md):

- Polymarket perps: `GET https://api.perpetuals.polymarket.com/v1/info/portfolio?address=0x…`
  → position with `symbol == "WTIOIL-USD"`; `size` is signed (+ long, − short).
- Hyperliquid: `POST https://api.hyperliquid.xyz/info` with
  `{"type":"clearinghouseState","user":"0x…","dex":"xyz"}` → position with
  `coin == "xyz:CL"`; `szi` is signed.

Alignment logic: position sign vs `reading.side` — long position + `side: "long"` (or short +
`"short"`) → **HOLD**; opposed → **EXIT-CANDIDATE**; `reading_missing` or `degraded` or
`is_current: false` → **WATCH** (do not act on a stale read). Always surface the hourly
`funding_rate` on the held venue — funding drag is material on a 20x perp held across days.
Advisory only; same disclaimer.

## Polling cadence

Signals publish **once daily around 10:15 ET**, but active signals inherit new context whenever
their market forecast refreshes. Polling more often than the six-hour `is_fresh` horizon is
usually unnecessary; the fast path between reads is `/api/v1/portfolio` plus keyless CLOB re-quotes.

| Feed | Cadence | Why |
|---|---|---|
| `/api/v1/signals`, `/api/v1/signals/featured` | every 4–6h | active signals can receive fresh forecasts throughout their seven-day hold |
| `/api/v1/signals/oil` | 1–2x daily (marks refresh live per call) | reading is a frozen daily read |
| `/api/v1/portfolio` | every 1–4h | live position join; short server cache |
| Keyless CLOB midpoints / book (pm.sh) | as needed, 15–30 min for spread watching | free — no Quotient spend |
| `/api/v1/markets/{slug}/forecast` + `/api/v1/sources` | on demand; 2–4x daily for watched markets | forecasts refresh on schedule + event triggers |
