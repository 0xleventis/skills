# Platform notes

Deeper detail behind each `platforms/*.mjs` builder — read this when something fails and the one-line error
isn't enough to explain why. Contract addresses/ABIs here are ported as of this skill's creation; if a
platform's on-chain behavior drifts, the corresponding `o1-creator-bot/src/api/*Client.ts` file (Bruno's own
bot repo) is the canonical source to re-sync against.

## o1.exchange (`platforms/o1exchange.mjs`) — Base, factory `0xa52ad4...6bb9F`

- `createLaunch`'s ETH-quote creation fee is **live and owner-adjustable, not reliably zero** — a real launch
  once reverted on-chain because this was assumed to be 0. The script always reads `quotes(zeroAddress)`
  fresh and sends it as `value`.
- Only the STANDARD factory/plain-ETH-quote path is ported. o1.exchange also has an RWA factory for
  stock-paired launches (mining a vanity salt, extra fees) — not implemented here; if a user asks to pair a
  launch with a tokenized stock, say that's not supported by this skill yet.
- Metadata pinning hits `exciting-fox-990.convex.cloud` directly — no auth needed, it's o1.exchange's own
  public endpoint.

## based.bid (`platforms/basedbid.mjs`) — Base, Diamond `0x0F2C33F4...0286`

- Uses the **Uniswap V3 flash-launch route** (`customFlashLaunchV3`) exclusively. based.bid's V4 route
  (`customFlashLaunchV4`) has a genuine bug on their own side (every V4 call reverts with Uniswap V4's
  `HookAddressNotValid`) — confirmed by extensive live investigation in Bruno's own integration work. Don't
  try to "fix" this by switching to V4.
- based.bid's backend (`static.based.bid/api/create-flash`) returns the exact function name + args + value
  to call — this script re-encodes whatever it returns. If it ever returns something other than
  `customFlashLaunchV3`, the script throws rather than guessing an ABI, since a wrong ABI produces a wrong
  function selector, not a decode error.
- A `virtualEth` field in the returned args can come back `null` — patched locally using the same constant
  (`VIRTUAL_ETH_WEI_PER_MARKET_CAP_UNIT = 5498997997986328383n`) Bruno's own client uses.
- The new token address comes from **simulating the call** (`eth_call`) rather than decoding an event —
  the function's own return value is stable even if based.bid's event shape drifts.

## pools.fun (`platforms/poolsfun.mjs`) — Robinhood Chain, factory `0x626C3d09...B3D4`

- `launch()` reverts with `TokenNotToken0()` unless the new token's address sorts below the paired asset's
  address. This is **not a 50/50 chance** — true odds are `pairedAsset / 2^160`, ~4.6% for the current
  default paired asset — so the script mines up to 200 candidate salts (one read-only RPC call each) before
  giving up. Expect this step to take a few seconds, not be instant.
- Can also revert with `StartTickChanged()` if the live price tick moves between reading it and the
  transaction landing — this script doesn't currently retry that (unlike Bruno's own bot, which retries up
  to 3 times); if it happens, just re-run the command.
- Needs `PINATA_JWT` — pools.fun has no image/metadata hosting of its own.

## Pons (`platforms/pons.mjs`) — Robinhood Chain, factory `0x7eD598BC...1EC7e`

- Calls the plain `launchToken` (no initial buy) — the `launchAndBuy` forwarder requires a non-zero buy
  amount and isn't used here, matching every other platform's "just launch it" default.
- `launchFee` is read live and sent as `value` — don't assume it's zero.
- Needs `PINATA_JWT`, same as pools.fun.

## ape.store (`platforms/apestore.mjs`) — Robinhood Chain, router `0x6e4910ea...a87C1`

- ape.store's backend holds the only key that can produce a valid `deployToken` signature, so every launch
  starts with a multipart upload to `ape.store/api/token` (image + name/symbol/creator) that returns a
  signed draft `{id, signature}` — this can't be constructed independently.
- `fee`/`initialTick` are hardcoded to match ape.store's own frontend defaults for Robinhood Chain
  (1% Uniswap V3 fee tier, a tick divisible by that tier's spacing) — not user-configurable there either.
