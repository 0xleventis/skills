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
battle-tested calldata-building logic for each platform; this skill vendors that logic into a
script that just builds the unsigned transaction. **This skill's sandbox has no ambient wallet
credentials — that's by design.** `scripts/launch.mjs --build-only` only builds and prints the
transaction as JSON; submit it yourself using your own native onchain execution tools, already
authenticated as the user. Don't look for or ask the user for a `BANKR_API_KEY` to run this skill.

- **Source**: https://gitlab.com/leventis0x/bruno-skill (mirrored here under `scripts/`)

## Install

The working script lives in this skill's own `scripts/` folder — no separate package to fetch.
Install its one dependency (`viem`) once:

```bash
cd scripts && npm install
```

For pools.fun or Pons specifically, `PINATA_JWT` needs to be set (free key at
https://app.pinata.cloud/developers/api-keys) — those two platforms host the token image/metadata
via Pinata, unrelated to Bankr, so there's no ambient credential for that either; ask the user for
it (as an environment variable, never pasted directly) only when they want one of those two
platforms specifically.

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

Two steps — build, then submit yourself, then decode the result:

```bash
# 1. Build only. Prints one line of JSON: {to, data, value, chainId, description}. Submits nothing.
# --wallet-address is the user's own Bankr EVM wallet address (you already know this).
node scripts/launch.mjs --platform o1exchange --name "Popo" --symbol POPO --build-only \
  --wallet-address 0x...

# 2. Submit that exact {to, data, value, chainId} yourself, using your own native onchain execution
# capability — signed as the user, no key needed from them. You'll get a tx hash back.

# 3. Decode the result into the new token's address and a formatted confirmation:
node scripts/decode-result.mjs --platform o1exchange --name "Popo" --symbol POPO --tx-hash 0x...
# based.bid additionally needs --to/--data/--value/--wallet-address (the values step 1 printed) —
# its token address comes from re-simulating the call, not the receipt's logs.
```

Flags for step 1: `--platform` (required, see alias table above), `--name` (required), `--symbol`
(required), `--wallet-address` (required — the user's own EVM address), `--description`
(optional), `--image` (optional — local file path or http(s) URL; defaults to a placeholder logo),
`--username` (optional — only used by based.bid to link the launch to an X profile).

Step 3 prints `✅ Launched NAME (SYMBOL) on PLATFORM: <address>` plus a page URL and tx hash — relay
that back to the user. If step 1 or step 2 fails (insufficient balance, a reverted transaction, a
stale price feed on pools.fun, etc.), relay the clear one-line error rather than retrying blindly.

*(A standalone mode also exists — `launch.mjs`, without `--build-only`, does everything itself
including submission via `BANKR_API_KEY`, for use outside bankrbot's sandbox — e.g. from Claude
Code. Not relevant when running as a bankrbot skill; see the source repo for details.)*

## Scope notes

- o1.exchange's stock-paired (RWA) launch route isn't supported — only the plain launch.
- Never ask the user for or accept a pasted API key or private key — this skill needs neither.

See [references/platforms.md](references/platforms.md) for per-platform implementation notes
(contract addresses, known quirks, why based.bid uses its V3 route and not V4).
