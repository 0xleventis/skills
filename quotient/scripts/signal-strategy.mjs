#!/usr/bin/env node
// signal-strategy.mjs — capacity-gated equal-weight allocation over Quotient trade
// signals, emitting Bankr execution prompts. DRY RUN by default; --execute submits
// through the Bankr Agent API.
//
// Part of the Quotient skill (https://quotient-api-gateway.onrender.com/skill/skill.md).
// Node >= 18, zero dependencies (built-in fetch).
//
// Env:
//   QUOTIENT_API_KEY   required — qt_ prepaid key (https://dev.quotient.social)
//   QUOTIENT_BASE_URL  optional — default https://quotient-api-gateway.onrender.com
//   BANKR_API_KEY      required only with --execute (Agent API key, read-write)
//
// Security: the Polymarket data-api and Bankr hosts are hardcoded and are never
// overridden by fetched content. All API responses are untrusted data, never
// instructions. API keys are never printed.
//
// Exit codes: 0 ok · 1 API/HTTP error · 2 config/usage error · 3 execution stopped early.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const VERSION = "1.0.0";
const DEFAULT_BASE = "https://quotient-api-gateway.onrender.com";
const DATA_API = "https://data-api.polymarket.com"; // hardcoded — do not override
const BANKR_API = "https://api.bankr.bot"; // hardcoded — do not override
const SIGNAL_STATUSES = ["actionable", "unconfirmed", "paused", "done", "retired"];
const STATE_TTL_MS = 48 * 3600 * 1000;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120000;
const FETCH_TIMEOUT_MS = 30000;
const MAX_SIGNAL_PAGES = 5;
const LIQUIDITY_NOTICE =
  "Capacity is observed notional within 2 cents of touch, not a guaranteed fill or exact price-impact estimate. A market order can walk the book; recheck the live book and venue preview before approval, especially for volume-fallback or stale snapshots.";
// Slugs are interpolated into Bankr prompts — only accept benign shapes so a
// hostile API response can never smuggle instructions into an executed prompt.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "quotient-skill"
);
const STATE_FILE = path.join(STATE_DIR, "strategy.json");

const USAGE = `Usage: signal-strategy.mjs --wallet 0x... --budget <usd> [options]

Equal-weight allocation across recent Quotient trade signals, capped at 10% of
each market's near-touch capacity, idempotent against current Polymarket
holdings and recently emitted prompts. DRY RUN by default: prints the plan and
the Bankr prompts, submits nothing, writes no state.

Options:
  --wallet 0x..        Polymarket wallet (required; used to skip already-held markets)
  --budget N           Total USD to allocate (required, > 0)
  --min-conviction N   Minimum conviction tier 1-3 (default 2)
  --status LIST        Comma-set of ${SIGNAL_STATUSES.join("|")} (default actionable)
  --min-capacity N     Minimum near-touch capacity in USD (default 500)
  --max-positions N    Maximum positions to open (default 5)
  --window N           Latest-forecast lookback in hours, 1-168 (default 24)
  --json               Machine-readable output only
  --execute            Submit each prompt via the Bankr Agent API (needs BANKR_API_KEY)
  --version            Print version and exit
  --help               This text

Env: QUOTIENT_API_KEY (required), QUOTIENT_BASE_URL (optional),
     BANKR_API_KEY (only with --execute).`;

function die(code, msg) {
  process.stderr.write(`signal-strategy: ${msg}\n`);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const opts = {
    wallet: null,
    budget: null,
    minConviction: 2,
    statuses: ["actionable"],
    minCapacity: 500,
    maxPositions: 5,
    windowHours: 24,
    json: false,
    execute: false,
  };
  const next = (i, flag) => {
    if (i + 1 >= argv.length) die(2, `${flag} requires a value\n\n${USAGE}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--wallet":
        opts.wallet = next(i, a);
        i++;
        break;
      case "--budget":
        opts.budget = Number(next(i, a));
        i++;
        break;
      case "--min-conviction":
        opts.minConviction = Number(next(i, a));
        i++;
        break;
      case "--status":
        opts.statuses = next(i, a)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i++;
        break;
      case "--min-capacity":
        opts.minCapacity = Number(next(i, a));
        i++;
        break;
      case "--max-positions":
        opts.maxPositions = Number(next(i, a));
        i++;
        break;
      case "--window":
        opts.windowHours = Number(next(i, a));
        i++;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--execute":
        opts.execute = true;
        break;
      case "--version":
        process.stdout.write(`signal-strategy.mjs ${VERSION}\n`);
        process.exit(0);
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        die(2, `unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  if (!opts.wallet || !/^0x[0-9a-fA-F]{40}$/.test(opts.wallet)) {
    die(2, `--wallet must be a 0x-prefixed 40-hex Polymarket address\n\n${USAGE}`);
  }
  opts.wallet = opts.wallet.toLowerCase();
  if (!Number.isFinite(opts.budget) || opts.budget <= 0) {
    die(2, `--budget must be a positive USD amount\n\n${USAGE}`);
  }
  if (!Number.isInteger(opts.minConviction) || opts.minConviction < 1 || opts.minConviction > 3) {
    die(2, "--min-conviction must be 1, 2, or 3");
  }
  const badStatus = opts.statuses.filter((s) => !SIGNAL_STATUSES.includes(s));
  if (!opts.statuses.length || badStatus.length) {
    die(2, `--status must be a comma-set of: ${SIGNAL_STATUSES.join(", ")}`);
  }
  if (!Number.isFinite(opts.minCapacity) || opts.minCapacity < 0) {
    die(2, "--min-capacity must be a non-negative USD amount");
  }
  if (!Number.isInteger(opts.maxPositions) || opts.maxPositions < 1) {
    die(2, "--max-positions must be a positive integer");
  }
  if (!Number.isInteger(opts.windowHours) || opts.windowHours < 1 || opts.windowHours > 168) {
    die(2, "--window must be an integer between 1 and 168 (hours)");
  }
  return opts;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function quotientGet(base, apiKey, pathAndQuery) {
  let res;
  try {
    res = await fetch(base + pathAndQuery, {
      headers: { "x-quotient-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    die(1, `network error calling Quotient API: ${err.message}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (res.status === 200) {
    if (body == null) die(1, "Quotient API returned invalid JSON");
    return body;
  }
  const detail = body?.message || text.slice(0, 200);
  if (res.status === 401) {
    die(2, "Quotient API key rejected (401). Check QUOTIENT_API_KEY (get one at https://dev.quotient.social).");
  }
  if (res.status === 402) {
    die(2, "402 payment challenge — this script uses a prepaid qt_ key, not x402. Set QUOTIENT_API_KEY, or run the endpoints through your x402 client (see references/vanilla-x402-flow.md).");
  }
  if (res.status === 403) {
    die(2, "Insufficient Quotient credits (403). Top up at https://dev.quotient.social.");
  }
  if (res.status === 422) die(2, `invalid request (422): ${detail}`);
  die(1, `Quotient API error ${res.status}: ${detail}`);
}

async function fetchSignals(base, apiKey, opts) {
  const signals = [];
  let cursor = null;
  for (let page = 0; page < MAX_SIGNAL_PAGES; page++) {
    const params = new URLSearchParams({
      window: String(opts.windowHours),
      status: opts.statuses.join(","),
      min_conviction: String(opts.minConviction),
      min_capacity_usd: String(opts.minCapacity),
      limit: "50",
    });
    if (cursor) params.set("cursor", cursor);
    const body = await quotientGet(base, apiKey, `/api/v1/signals?${params}`);
    signals.push(...(Array.isArray(body.signals) ? body.signals : []));
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return signals;
}

/** Held set from the Polymarket data-api, keyed `conditionId:outcome` (lowercased).
 *  Fail-closed: an unreadable holdings list means no plan (never risk a re-buy). */
async function fetchHeldSet(wallet) {
  const held = new Set();
  for (let offset = 0; offset <= 1500; offset += 500) {
    const url = `${DATA_API}/positions?user=${wallet}&limit=500&offset=${offset}&sizeThreshold=1`;
    let res;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      die(1, `Polymarket data-api unreachable (${err.message}) — refusing to plan without a holdings check.`);
    }
    if (!res.ok) {
      die(1, `Polymarket data-api error ${res.status} — refusing to plan without a holdings check.`);
    }
    let page;
    try {
      page = await res.json();
    } catch {
      die(1, "Polymarket data-api returned invalid JSON — refusing to plan without a holdings check.");
    }
    if (!Array.isArray(page)) die(1, "unexpected Polymarket data-api response shape");
    for (const p of page) {
      if (p?.conditionId && p?.outcome) {
        held.add(`${p.conditionId}:${String(p.outcome).toLowerCase()}`);
      }
    }
    if (page.length < 500) break;
  }
  return held;
}

// ── Local emit-state (idempotency between prompt emission and fill visibility) ─

function loadState(nowMs) {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    die(1, `corrupt or unreadable state file ${STATE_FILE} — refusing to plan; inspect or delete it to proceed.`);
  }
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    die(1, `corrupt or unreadable state file ${STATE_FILE} — refusing to plan; inspect or delete it to proceed.`);
  }
  if (!Array.isArray(entries)) {
    die(1, `corrupt or unreadable state file ${STATE_FILE} — refusing to plan; inspect or delete it to proceed.`);
  }
  return entries.filter(
    (e) => e && typeof e.emittedAt === "string" && nowMs - Date.parse(e.emittedAt) < STATE_TTL_MS
  );
}

function saveState(entries) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  fs.renameSync(tmp, STATE_FILE);
}

// ── Bankr Agent API (only with --execute) ─────────────────────────────────────

async function bankrSubmit(bankrKey, prompt) {
  let res;
  try {
    res = await fetch(`${BANKR_API}/agent/prompt`, {
      method: "POST",
      headers: { "X-API-Key": bankrKey, "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `Bankr API unreachable: ${err.message}` };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  }
  if (!res.ok || !body?.jobId) {
    return { error: `Bankr submit failed (HTTP ${res.status})` };
  }
  return { jobId: body.jobId };
}

async function bankrPoll(bankrKey, jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let res;
    try {
      res = await fetch(`${BANKR_API}/agent/job/${jobId}`, {
        headers: { "X-API-Key": bankrKey, accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      continue; // transient — keep polling until the deadline
    }
    if (!res.ok) continue;
    let body = null;
    try {
      body = await res.json();
    } catch {
      continue;
    }
    if (["completed", "failed", "cancelled"].includes(body?.status)) return body.status;
  }
  return "timeout";
}

// ── Formatting ────────────────────────────────────────────────────────────────

const fmtUsd = (n) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
const trunc = (s, n) => (s.length > n ? s.slice(0, n) : s);

function printTable(rows) {
  const fmt = (c) =>
    [
      c[0].padEnd(22),
      c[1].padEnd(36),
      c[2].padEnd(5),
      c[3].padEnd(5),
      c[4].padStart(8),
      c[5].padStart(9),
      c[6].padStart(8),
      `  ${c[7]}`,
    ].join(" ");
  process.stdout.write(
    `${fmt(["SIGNAL", "MARKET", "SIDE", "TIER", "UPSIDE%", "CAPACITY", "SIZE", "ACTION"])}\n`
  );
  for (const r of rows) process.stdout.write(`${fmt(r)}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const apiKey = process.env.QUOTIENT_API_KEY;
  if (!apiKey) {
    die(2, "Set QUOTIENT_API_KEY (free key + starter credits at https://dev.quotient.social) or run these endpoints through your x402 client — see references/bankr-preferred-flow.md / vanilla-x402-flow.md.");
  }
  const bankrKey = process.env.BANKR_API_KEY;
  if (opts.execute && !bankrKey) {
    die(2, "--execute requires BANKR_API_KEY (Bankr Agent API key with read-write; `bankr login ... --agent-api --read-write`). Without it, run dry (default) and hand the prompts to Bankr yourself.");
  }
  const base = (process.env.QUOTIENT_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");

  const nowMs = Date.now();
  const asOf = new Date(nowMs).toISOString();
  const skipped = [];

  // (1) Candidates: server-side filters, then belt-and-braces client re-filter.
  const [fetched, held] = await Promise.all([
    fetchSignals(base, apiKey, opts),
    fetchHeldSet(opts.wallet),
  ]);

  const candidates = [];
  for (const s of fetched) {
    if (!s || typeof s.id !== "string") continue;
    if (s.side !== "YES" && s.side !== "NO") {
      skipped.push({ id: s.id, reason: "bad_side" });
    } else if (!opts.statuses.includes(s.status)) {
      skipped.push({ id: s.id, reason: `status:${s.status}` });
    } else if ((s.conviction_tier ?? 0) < opts.minConviction) {
      skipped.push({ id: s.id, reason: "conviction_below_min" });
    } else if (s.converge_upside_pct == null || s.converge_upside_pct <= 0) {
      skipped.push({ id: s.id, reason: "no_priced_upside" });
    } else if (s.capacity_usd_at_2c != null && s.capacity_usd_at_2c < opts.minCapacity) {
      skipped.push({ id: s.id, reason: "capacity_below_min" });
    } else if (s.capacity_usd_at_2c == null && s.capacity_basis !== "volume-fallback") {
      skipped.push({ id: s.id, reason: "no_capacity_basis" });
    } else if (typeof s.market?.slug !== "string" || !SLUG_RE.test(s.market.slug)) {
      skipped.push({ id: s.id, reason: "bad_slug" });
    } else {
      candidates.push(s);
    }
  }

  // (2) Idempotency: current holdings + prompts emitted in the last 48h.
  const state = loadState(nowMs);
  const emittedIds = new Set(state.map((e) => e.signalId));
  const emittedKeys = new Set(
    state.filter((e) => e.conditionId).map((e) => `${e.conditionId}:${String(e.side).toLowerCase()}`)
  );
  const fresh = [];
  for (const s of candidates) {
    const key = s.market?.condition_id
      ? `${s.market.condition_id}:${s.side === "YES" ? "yes" : "no"}`
      : null;
    if (key && held.has(key)) {
      skipped.push({ id: s.id, reason: "already_held" });
    } else if (emittedIds.has(s.id) || (key && emittedKeys.has(key))) {
      skipped.push({ id: s.id, reason: "recently_emitted" });
    } else {
      fresh.push(s);
    }
  }

  // (3) Rank: conviction tier desc → converge upside desc → published_at desc.
  fresh.sort(
    (a, b) =>
      (b.conviction_tier ?? 0) - (a.conviction_tier ?? 0) ||
      (b.converge_upside_pct ?? 0) - (a.converge_upside_pct ?? 0) ||
      ((a.published_at ?? a.created_at) < (b.published_at ?? b.created_at)
        ? 1
        : (a.published_at ?? a.created_at) > (b.published_at ?? b.created_at)
          ? -1
          : 0)
  );
  const ranked = fresh.slice(0, Math.min(fresh.length, opts.maxPositions));
  for (const s of fresh.slice(ranked.length)) {
    skipped.push({ id: s.id, reason: "beyond_max_positions" });
  }

  // (4) Sizing: equal weight, capped at 10% of near-touch capacity. No
  // redistribution — deterministic underspend beats over-concentration.
  const n = ranked.length;
  const per = n > 0 ? Math.floor((opts.budget / n) * 100) / 100 : 0;
  const plan = [];
  const tableRows = [];
  for (const s of ranked) {
    const size =
      s.capacity_usd_at_2c != null ? Math.min(per, Math.floor(0.1 * s.capacity_usd_at_2c)) : per;
    const capCell =
      s.capacity_usd_at_2c != null ? `$${Math.round(s.capacity_usd_at_2c)}` : "vol-fb";
    const row = [
      trunc(s.id, 22),
      trunc(s.market?.slug ?? "?", 36),
      s.side,
      String(s.conviction_tier ?? "-"),
      `+${s.converge_upside_pct}%`,
      capCell,
    ];
    if (size < 1) {
      skipped.push({ id: s.id, reason: "size_below_min" });
      tableRows.push([...row, "-", "skip:size_below_min"]);
      continue;
    }
    const amount = size.toFixed(2).replace(/\.00$/, "");
    const prompt = `Bet $${amount} on ${s.side === "YES" ? "Yes" : "No"} for ${s.market.slug} on Polymarket`;
    plan.push({
      signal_id: s.id,
      market: s.market.slug,
      condition_id: s.market.condition_id ?? null,
      side: s.side,
      conviction_tier: s.conviction_tier ?? null,
      converge_upside_pct: s.converge_upside_pct,
      capacity_usd_at_2c: s.capacity_usd_at_2c,
      capacity_basis: s.capacity_basis ?? null,
      capacity_as_of: s.capacity_as_of ?? null,
      proposed_size_pct_of_capacity:
        s.capacity_usd_at_2c > 0
          ? Math.round((size / s.capacity_usd_at_2c) * 10000) / 100
          : null,
      estimated_impact_band:
        s.capacity_usd_at_2c == null
          ? "unknown-no-depth-snapshot"
          : size <= s.capacity_usd_at_2c
            ? "inside-2c-snapshot-not-guaranteed"
            : "exceeds-2c-snapshot",
      current_cost_cents: s.current_cost_cents ?? null,
      live_priced: s.live_priced ?? false,
      priced_at: s.priced_at ?? null,
      price_impact_notice: LIQUIDITY_NOTICE,
      size_usd: size,
      prompt,
    });
    tableRows.push([...row, fmtUsd(size), "buy"]);
  }
  const budgetUsed = plan.reduce((sum, p) => sum + p.size_usd, 0);

  // Human plan output first, so the table precedes any execution lines.
  if (!opts.json) {
    process.stdout.write(
      `Quotient signal strategy — ${asOf}\nwallet ${opts.wallet} · budget ${fmtUsd(opts.budget)} · window ${opts.windowHours}h · status ${opts.statuses.join(",")} · min tier ${opts.minConviction} · min capacity ${fmtUsd(opts.minCapacity)}\n\n`
    );
    if (tableRows.length) {
      printTable(tableRows);
    } else {
      process.stdout.write("No eligible signals after filters.\n");
    }
    if (skipped.length) {
      const summary = skipped.map((sk) => `${trunc(sk.id, 22)} (${sk.reason})`).join(", ");
      process.stdout.write(`\nSkipped ${skipped.length}: ${summary}\n`);
    }
    process.stdout.write(`\nBudget used: ${fmtUsd(budgetUsed)} of ${fmtUsd(opts.budget)}\n`);
    if (plan.length) process.stdout.write(`Liquidity / price impact: ${LIQUIDITY_NOTICE}\n`);
  } else if (opts.execute && plan.length) {
    // Machine-readable result is emitted after execution; surface the mandatory
    // preflight warning on stderr before the first Bankr handoff.
    process.stderr.write(`signal-strategy: liquidity / price impact: ${LIQUIDITY_NOTICE}\n`);
  }

  // (5)/(6) Emit — dry run by default; --execute submits sequentially and
  // stops the batch on the first non-completed job.
  let executed = false;
  let stoppedEarly = false;
  if (opts.execute) {
    const stateOut = [...state];
    for (const p of plan) {
      if (!opts.json) process.stdout.write(`EXECUTE> bankr prompt "${p.prompt}"\n`);
      const sub = await bankrSubmit(bankrKey, p.prompt);
      if (sub.error) {
        p.job_status = "submit_failed";
        process.stderr.write(`signal-strategy: ${sub.error} — stopping batch.\n`);
        stoppedEarly = true;
        break;
      }
      p.job_id = sub.jobId;
      // Durable at submit time — a poll timeout must never cause a re-emit of
      // an order that may still fill.
      stateOut.push({
        signalId: p.signal_id,
        conditionId: p.condition_id,
        side: p.side,
        emittedAt: new Date().toISOString(),
      });
      saveState(stateOut);
      const status = await bankrPoll(bankrKey, sub.jobId);
      p.job_status = status;
      if (!opts.json) process.stdout.write(`         job ${sub.jobId}: ${status}\n`);
      if (status !== "completed") {
        process.stderr.write(`signal-strategy: job ${sub.jobId} ended ${status} — stopping batch.\n`);
        stoppedEarly = true;
        break;
      }
    }
    executed = !stoppedEarly;
  }

  // (7) Output.
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ as_of: asOf, plan, skipped, budget_used: budgetUsed, liquidity_notice: LIQUIDITY_NOTICE, executed }, null, 2)}\n`
    );
  } else if (!opts.execute) {
    for (const p of plan) process.stdout.write(`DRY-RUN> bankr prompt "${p.prompt}"\n`);
    if (plan.length) {
      process.stdout.write(
        "Dry run: nothing submitted, no state written. Add --execute (with BANKR_API_KEY) to submit via Bankr.\n"
      );
    }
  }
  process.exit(stoppedEarly ? 3 : 0);
}

main().catch((err) => {
  die(1, `unexpected error: ${err?.stack || err}`);
});
