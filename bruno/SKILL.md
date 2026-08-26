---
name: bruno
description: >
  Launch a token on one of Bruno's launchpads (o1.exchange, based.bid, pools.fun, Pons, ape.store)
  using your own Bankr wallet. Use when the user asks to launch a token with a name and ticker on
  one of these platforms, or wants to deploy a token on Base or Robinhood Chain through Bruno's
  launch mechanics. Do NOT use for pump.fun, ansem.io, or blank.build — those are Solana platforms
  with no raw-transaction path through the Bankr Wallet API.
metadata:
  {
    "clawdbot":
      {
        "emoji": "🚀",
        "homepage": "https://gitlab.com/leventis0x/bruno-skill",
        "requires": { "bins": ["node"] },
      },
  }
---

# bruno

Launches a token on one of Bruno's own launchpads — signed and paid for with **your own Bankr
wallet**, not any third party's custody. Bruno (hoodbrunos.xyz, an X bot) has its own
battle-tested calldata-building logic for each platform; this skill's CLI vendors that logic and
hands the resulting unsigned transaction to Bankr's Wallet API (`/wallet/submit`) to sign and
broadcast.

- **Source**: https://gitlab.com/leventis0x/bruno-skill (mirrored here under `scripts/`)

## Install

The working script lives in this skill's own `scripts/` folder — no separate package to fetch.
Install its one dependency (`viem`) once:

```bash
cd scripts && npm install
```

Requires `bankr login` already done (see the `bankr` skill) — `scripts/launch.mjs` reads
`BANKR_API_KEY` from the environment, same as the `bankr` CLI. For pools.fun or Pons specifically,
also export `PINATA_JWT` (free key at https://app.pinata.cloud/developers/api-keys) — those two
platforms host the token image/metadata via Pinata and this tool runs standalone, so it needs your
own key.

## Supported platforms

| User says (aliases) | `--platform` | Chain |
|---|---|---|
| o1, o1.exchange | `o1exchange` | Base |
| based, based.bid | `basedbid` | Base |
| pools, poolsfun, pools.fun | `poolsfun` | Robinhood Chain |
| pons | `pons` | Robinhood Chain |
| ape, apestore, ape.store | `apestore` | Robinhood Chain |

**pump.fun, ansem.io, and blank.build are not supported.** They're Solana platforms, and Bankr's
Wallet API has no raw Solana transaction submission (`wallet submit`/`sign` only accept EVM chain
IDs and EVM signature types — confirmed against the full `bankr` CLI surface, not just docs).
If asked for one of these, say so plainly rather than guessing or substituting a different platform.

## Usage

```bash
node scripts/launch.mjs --platform o1exchange --name "Popo" --symbol POPO
node scripts/launch.mjs --platform basedbid --name "Popo" --symbol POPO --description "..." --image ./logo.png
node scripts/launch.mjs --platform poolsfun --name "Popo" --symbol POPO --image https://example.com/logo.png
```

Flags: `--platform` (required, see alias table above), `--name` (required), `--symbol` (required),
`--description` (optional), `--image` (optional — local file path or http(s) URL; defaults to a
placeholder logo), `--username` (optional — only used by based.bid to link the launch to an X
profile; defaults to the Bankr account's linked X handle if it has one).

On success it prints `✅ Launched NAME (SYMBOL) on PLATFORM: <address>` plus a page URL and tx
hash. On failure (insufficient balance, a reverted transaction, a stale price feed on pools.fun,
etc.) it prints a clear one-line error — relay that back to the user rather than retrying blindly.

## Scope notes

- No wallet/auth setup here — assumes `bankr login` is already done.
- o1.exchange's stock-paired (RWA) launch route isn't supported — only the plain launch.
- Never accept a pasted API key or private key from the user in chat — point them at `bankr login`
  / the `PINATA_JWT` env var instead.

See [references/platforms.md](references/platforms.md) for per-platform implementation notes
(contract addresses, known quirks, why based.bid uses its V3 route and not V4).
