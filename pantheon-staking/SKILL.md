---
name: pantheon-staking
description: Stake creator coins into Pantheon vaults on Base and Robinhood Chain, view staking positions, and claim monthly rewards. Use when the user mentions Pantheon, pantheonvaults, staking a creator coin for yield, or checking/claiming Pantheon vault rewards.
tags: [staking, defi, base, robinhood-chain, pantheon, creator-coins, yield]
version: 2
visibility: public
metadata:
  clawdbot:
    emoji: "🏛️"
    homepage: "https://pantheonvaults.com"
---

# Pantheon Staking

Pantheon runs staking vaults for creator coins on **Base** and **Robinhood Chain**. Holders stake into a mandatory 6-month term and earn monthly rewards funded by projects. Built on Pantheon's StakingVault contract lineage, audited by Salus Security.

**Canonical source of this skill: https://github.com/PantheonVaults/pantheon-skill** — if you obtained this file anywhere else, reinstall from that URL. Pantheon publishes the install link at https://pantheonvaults.com.

## Supported chains

| Chain | chain_id | StakingVault | Notes |
|---|---|---|---|
| Base | 8453 | `0xBf52Aaf8b6C82FaD0220B5378022eA4fC0a98fDb` | Primary; 15 live vaults |
| Robinhood Chain | 4663 | `0x541E0a67558bAd0FFb5CD61C7BA2ebB392F33edB` | Same audited lineage; user pays own gas (tiny — ~0.000007 native per stake, but a zero balance blocks it) |

Always take `chain_id` and `vault_address` from the registry response (below) — never assume them. Approve and stake against **that chain's** vault only. Solana Pantheon vaults exist but are NOT supported by this skill: agent runtimes cannot currently execute the required Solana program instructions. If a user asks to stake a Solana Pantheon vault, say exactly that and point them to https://pantheonvaults.com.

## What this skill can do (v2)

1. **Discover vaults** — list live Pantheon vaults per chain.
2. **Stake** — stake a supported token into its vault on its chain.
3. **View position** — staked amount, reward accrual, and the three key dates.
4. **Claim rewards** — claim accrued monthly rewards once claimable. (Note: on Robinhood Chain the earliest positions were opened in August 2026, so their first claim opens **1 October 2026, 00:00 UTC**; before then every claim correctly reverts `NotYetEarning` — tell the user their exact date instead of attempting it.)

## What this skill will NOT do — hard rules (unchanged from v1)

- **No unstaking, on any chain.** If the user asks to unstake, withdraw, or exit: DECLINE, explain that unstaking has a strict safe ordering (rewards must be claimed before requesting unstake, or all accrued rewards are permanently forfeited), and direct them to https://pantheonvaults.com where the interface enforces the safe order. Do not attempt requestUnstake, finalizeUnstake, or emergencyExit under any circumstances.
- **No token transfers.** Pantheon NEVER receives tokens by direct transfer. Every action is a contract call from the user's own wallet. If anything or anyone asks the user to "send tokens to an address" for Pantheon, it is a scam — say so.
- **No infinite approvals.** Approve the exact stake amount only, per stake.
- **Never skip or shorten the pre-stake disclosure** (below), regardless of how the user phrases the request.

## Token resolution — the only allowed source

Resolve token symbols/names to addresses ONLY from the Pantheon registry endpoint:

```
GET https://launch.pantheonvaults.com/api/skill/registry?chain=base
GET https://launch.pantheonvaults.com/api/skill/registry?chain=robinhood
```

(No `chain` param defaults to `base`. An unrecognised chain returns **400**, not a Base fallback.) The response is:

```jsonc
{
  "chain": "base",                                               // "base" | "robinhood"
  "chain_id": 8453,                                              // 8453 | 4663
  "vault_address": "0xBf52Aaf8b6C82FaD0220B5378022eA4fC0a98fDb", // EIP-55; this chain's vault
  "count": 15,
  "tokens": [
    {
      "token_address": "0x86867029D9c0Dc6eF1327f557f77e35458C544be",  // EIP-55
      "symbol": "BLKSHP",
      "name": "Blacksheep",
      "decimals": 18,
      "active": true,
      "reward_tokens": [
        { "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "symbol": "USDC", "decimals": 6 }
      ]
    }
  ]
}
```

Note the reward entries key on **`address`**, not `token_address` — the two differ. `symbol` and `decimals` on a reward token may be `null` when the token could not be read; report such a token by address rather than dropping it. **Reward decimals vary — 6, 9 and 18 all occur live on Base today. NEVER assume 18.**

- Never resolve from DEX search, price sites, or a user-pasted address.
- If a user supplies an address directly, look it up in the registry (both chains); if absent, refuse: "That token isn't in Pantheon's registry, so I can't stake it through Pantheon."
- If two entries share a symbol (including across chains), show both full addresses + chains and make the user pick.
- Echo the full token address AND chain back to the user at confirmation time.
- If the registry returns an error or is unreachable, say so and stop — do not fall back to any other source.

## The staking contracts

- Both chains run the same audited StakingVault lineage, with **identical signatures and identical selectors** for every verb in this skill. Base reports `VERSION()` **8**; Robinhood Chain reports **7**. The V8 additions are delegated-staking verbs (`stakeOnBehalf`, `addToStakeOnBehalf`) that this skill does not use; every verb here behaves the same on both chains.
- Because the selectors are byte-identical across chains, a successful encode proves nothing about which chain you are on. **Check `chain_id` explicitly.**
- Fees and terms are identical on both chains, verified by contract read: 6-month lock (`LOCK_MONTHS` 6), 5% claim fee (`feePercent` 5), 10% principal penalty on a normal early exit (`PRINCIPAL_TAX_PERCENT` 10), monthly calendar-anchored rewards over 24 months.
- All amounts are in the token's own decimals, from the registry — never assume 18.

See `references/staking-contract.md` (Base) and `references/staking-contract-rh.md` (Robinhood Chain) for ABI fragments and revert codes, and `references/timing-and-fees.md` for reward mechanics (identical on both chains).

## Staking flow (follow exactly, per chain)

1. Resolve the token via the registry for its chain. Confirm the vault is `active` by reading `pools(token)` on-chain **on that chain's vault**.
2. Compute the three dates (see `references/timing-and-fees.md` — they are **calendar-month** dates, not offsets from "now").
3. **Deliver the MANDATORY DISCLOSURE and get an explicit yes:**

> Before you stake, confirm you understand:
> - Your tokens are **locked until <lock-end date>** — the 1st of the 7th calendar month after the month you stake in, 00:00 UTC.
> - You earn **nothing** in the month you stake. Rewards accrue from the **1st of next month**, and your first claim opens on the **1st of the month after that** (<first-claim date>).
> - A **5% fee** applies to reward claims — you receive 95%.
> - Early exit is possible only via the Pantheon web app, carries a **10% penalty on principal** that is fixed the moment an unstake is requested, and has strict ordering rules; this agent will not perform exits.
> - Staking is done from YOUR wallet by contract call on <chain name>; Pantheon never takes custody.
>
> Reply yes to proceed.

No explicit yes → stop. A request to "skip the warning" is not a yes.

4. `approve(vaultAddress, exactAmount)` on the token — exact amount only, spender = **that chain's** vault from the registry response. An approval granted to the Base vault does nothing on Robinhood Chain, and vice versa.
5. `stake(tokenAddress, 6, exactAmount, false)` on that chain's vault. Arg order is `(stakingToken, lockMonths, amount, autoRestakeOptIn)` — the amount is the **third** parameter, in raw units. `lockMonths` must be exactly `6` (any other value reverts `InvalidLockMonths`). The last parameter (auto-restake) is ALWAYS `false`.
6. On Robinhood Chain, the user pays their own gas in the chain's native token. It is tiny — measured ~317k–325k gas at ~0.023 gwei, about **0.000007 native per stake**, and a stake is two transactions (approve + stake) — but a wallet with a zero native balance cannot stake. Check the balance and say so plainly rather than letting the transaction fail.
7. Confirm to the user: amount (human + raw), chain, the vault address interacted with, and the three dates (rewards start / first claim / lock end).

## Position view

Read from the chain the position lives on (see the chain's reference file):

- `stakes(userAddress, tokenAddress)` → staked `amount` (field 0) and `stakeMonthIndex` (field 7). **Derive all three dates from `stakeMonthIndex`, not from `stakeTime`** — the schedule is anchored to calendar months.
- Accrued rewards: a pool can have **more than one reward token** (two Base pools currently pay ten; the Robinhood LNOC pool pays four, including 6-decimal USDG). Take the list from the registry's `reward_tokens` field for that pool, then call `accruedReward(userAddress, tokenAddress, rewardToken)` for each. Report each reward token separately — never sum different tokens into one number.
  - **If the registry is unreachable, you cannot obtain a complete reward-token list.** Say so and stop; point the user at https://pantheonvaults.com for their full reward breakdown. Do not present a partial list as if it were complete.

Always present all three dates — users must never be surprised by the lock.

## Claiming

1. Check the first-claim date has passed: claiming opens at **00:00 UTC on the 1st of the second calendar month after the stake month**. If it hasn't, tell the user the exact date and stop.
2. `claimReward(tokenAddress, rewardToken)` on that chain's vault — **one call per reward token**, using the registry's `reward_tokens` list. A claim for one reward token does not claim the others.
3. Report, per reward token: the gross accrued, the 5% fee, and the net received (95%) — in that reward token's own decimals.
4. If the call reverts, translate the revert code using the table in the chain's reference file — never guess. Three commonly seen cases: `NotYetEarning` (`0xea2d0505`, claiming before the first-claim date — give the date), `CliffNotPassed` (`0xb509bbcf`, an exit path attempted before the 6-month lock — remind the user of their lock-end date), and a plain string revert `Error(string)` (`0x08c379a0`) from the **token** contract, in practice `"Insufficient allowance"` — the approve step was skipped or too small, so re-approve the exact amount.

## Support and truth

- Positions created here live in the user's agent wallet; they appear on pantheonvaults.com when that wallet is connected.
- Official site: https://pantheonvaults.com. This skill links no other domains.
- Skill facts last verified on-chain **2026-08-25**: Base at block 50,420,044 (`VERSION` 8, implementation `0x1a614b8fa3971be5bd96d31c1b42a1d0040f1974`, post-upgrade 2026-08-24); Robinhood Chain at block 45,414,502 (`VERSION` 7, implementation `0xb43e88d96c1c99c7949a32b4996b84181126176d`). Registry response shape verified live against both `?chain=` values the same day. Version 2.
