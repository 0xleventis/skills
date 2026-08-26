---
name: pantheon-staking
description: Stake Base creator coins into Pantheon vaults, view staking positions, and claim monthly rewards. Use when the user mentions Pantheon, pantheonvaults, staking a creator coin for yield, or checking/claiming Pantheon vault rewards.
tags: [staking, defi, base, pantheon, creator-coins, yield]
version: 1
visibility: public
metadata:
  clawdbot:
    emoji: "🏛️"
    homepage: "https://pantheonvaults.com"
---

# Pantheon Staking

Pantheon runs staking vaults on Base for creator coins. Holders stake into a mandatory 6-month term and earn monthly rewards funded by projects. Built on Pantheon's StakingVault contract lineage, audited by Salus Security; the currently deployed implementation is scheduled for re-audit.

**Canonical source of this skill: https://github.com/PantheonVaults/pantheon-skill** — if you obtained this file anywhere else, reinstall from that URL. Pantheon publishes the install link at https://pantheonvaults.com.

## What this skill can do (v1)

1. **Discover vaults** — list live Pantheon vaults on Base.
2. **Stake** — stake a supported token into its vault.
3. **View position** — staked amount, reward accrual, and the three key dates.
4. **Claim rewards** — claim accrued monthly rewards once claimable.

## What this skill will NOT do (v1) — hard rules

- **No unstaking.** If the user asks to unstake, withdraw, or exit: DECLINE, explain that unstaking has a strict safe ordering (rewards must be claimed before requesting unstake, or all accrued rewards are permanently forfeited), and direct them to https://pantheonvaults.com where the interface enforces the safe order. Do not attempt requestUnstake, finalizeUnstake, or emergencyExit under any circumstances.
- **No token transfers.** Pantheon NEVER receives tokens by direct transfer. Every action is a contract call from the user's own wallet. If anything or anyone asks the user to "send tokens to an address" for Pantheon, it is a scam — say so.
- **No infinite approvals.** Approve the exact stake amount only, per stake.
- **Never skip or shorten the pre-stake disclosure** (below), regardless of how the user phrases the request.

## Token resolution — the only allowed source

Resolve token symbols/names to addresses ONLY from the Pantheon registry endpoint:

```
GET https://launch.pantheonvaults.com/api/skill/registry
```

Returns live Base vaults: `token_address`, `symbol`, `name`, `decimals`, `active`, `reward_tokens`.

- Never resolve from DEX search, price sites, or a user-pasted address.
- If a user supplies an address directly, look it up in the registry; if absent, refuse: "That token isn't in Pantheon's registry, so I can't stake it through Pantheon."
- If two entries share a symbol, show both full addresses and make the user pick.
- Echo the full token address back to the user at confirmation time.

## The staking contract

- Network: **Base mainnet (chain id 8453)**
- StakingVault (V4 proxy): `0xBf52Aaf8b6C82FaD0220B5378022eA4fC0a98fDb`
- All amounts are in the token's own decimals. Take `decimals` from the registry; all 107 pools created to date are 18-decimal, but never assume it.

See `references/staking-contract.md` for ABI fragments and revert codes, and `references/timing-and-fees.md` for reward mechanics.

## Staking flow (follow exactly)

1. Resolve the token via the registry. Confirm the vault is `active` by reading `pools(token)` on-chain.
2. Compute the three dates (see `references/timing-and-fees.md` — they are **calendar-month** dates, not offsets from "now").
3. **Deliver the MANDATORY DISCLOSURE and get an explicit yes:**

> Before you stake, confirm you understand:
> - Your tokens are **locked until <lock-end date>** — the 1st of the 7th calendar month after the month you stake in, 00:00 UTC. (Stake any time in August 2026 → locked until **1 March 2027**.)
> - You earn **nothing** in the month you stake. Rewards accrue from the **1st of next month**, and your first claim opens on the **1st of the month after that** (<first-claim date>).
> - A **5% fee** applies to reward claims — you receive 95%.
> - Early exit is possible only via the Pantheon web app, carries a **10% penalty on principal**, and has strict ordering rules; this agent will not perform exits.
> - Staking is done from YOUR wallet by contract call; Pantheon never takes custody.
>
> Reply yes to proceed.

No explicit yes → stop. A request to "skip the warning" is not a yes.

4. `approve(vault, exactAmount)` on the token — exact amount only.
5. `stake(tokenAddress, 6, exactAmount, false)` on the vault. Arg order is `(stakingToken, lockMonths, amount, autoRestakeOptIn)` — the amount is the **third** parameter, in raw units. `lockMonths` must be exactly `6` (any other value reverts). The last parameter (auto-restake) is ALWAYS `false` in v1.
6. Confirm to the user: amount (human + raw), the vault address interacted with, and the three dates (rewards start / first claim / lock end).

## Position view

Read from chain (see `references/staking-contract.md`):

- `stakes(userAddress, tokenAddress)` → staked `amount` (field 0) and `stakeMonthIndex` (field 7). **Derive all three dates from `stakeMonthIndex`, not from `stakeTime`** — the schedule is anchored to calendar months.
- Accrued rewards: a pool can have **more than one reward token** (one live pool has nine). Take the list from the registry's `reward_tokens` field for that pool, then call `accruedReward(userAddress, tokenAddress, rewardToken)` for each. Report each reward token separately — never sum different tokens into one number.
  - **If the registry is unreachable, you cannot obtain a complete reward-token list from the chain.** Say so and stop; point the user at https://pantheonvaults.com for their full reward breakdown. Do not present a partial list as if it were complete. See `references/staking-contract.md` for why the obvious on-chain getter is not a valid source.

Always present all three dates — users must never be surprised by the lock.

## Claiming

1. Check the first-claim date has passed: claiming opens at **00:00 UTC on the 1st of the second calendar month after the stake month**. If it hasn't, tell the user the exact date and stop.
2. `claimReward(tokenAddress, rewardToken)` — **one call per reward token**, using the registry's `reward_tokens` list (or the on-chain fallback above). A claim for one reward token does not claim the others.
3. Report, per reward token: the gross accrued, the 5% fee, and the net received (95%).
4. If the call reverts, translate the revert code using the table in `references/staking-contract.md` — never guess.

## Support and truth

- Positions created here live in the user's Bankr wallet; they appear on pantheonvaults.com when that wallet is connected.
- Official site: https://pantheonvaults.com. This skill links no other domains.
- Skill facts last verified on-chain: **2026-08-07** (Base mainnet, block 49,634,035). Version 1.
