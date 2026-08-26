# Pantheon StakingVault — contract reference (Base)

Vault (V4 proxy): `0xBf52Aaf8b6C82FaD0220B5378022eA4fC0a98fDb` — Base mainnet, chain id 8453.
Live implementation behind the proxy: `0xe0c448b467db7c65ed8a0827e057d81d526919b2`.
All signatures below were checked against the deployed ABI on 2026-08-07 (see the G1 evidence table).

## ABI fragments (call these exactly)

```
function stake(address stakingToken, uint16 lockMonths, uint256 amount, bool autoRestakeOptIn)
function accruedReward(address user, address stakingToken, address rewardToken) view returns (uint256)
function claimReward(address stakingToken, address rewardToken)
function pools(address stakingToken) view returns (bool active, uint32 cliffMonths, uint256 totalStaked)
function stakes(address user, address stakingToken) view returns (
    uint256 amount,
    bool    autoRestake,
    uint16  lockMonths,
    uint32  lockDuration,
    uint32  stakeTime,
    uint32  unstakeRequestTime,
    uint32  unstakeTime,
    uint32  stakeMonthIndex,
    bool    compounderEnabled
)
```

Selectors, if you need to match them: `stake` `0x946debd5` · `accruedReward` `0x814b57b3` · `claimReward` `0x4953c782` · `pools` `0xa4063dbc` · `stakes` `0xa4e47b66`.

ERC-20 approve first: `approve(0xBf52Aaf8b6C82FaD0220B5378022eA4fC0a98fDb, exactAmount)` on the token contract.

Rules:
- `lockMonths` is always `6` — the contract rejects every other value. `autoRestakeOptIn` is always `false` (v1 policy).
- In `stake`, the **amount is the third argument**, after `lockMonths`. Getting this order wrong is the easiest way to send a wrong-sized transaction.
- Amounts are raw units (`human * 10^decimals`, decimals from the registry).
- Before staking, check `pools(token).active == true`; if false, refuse — the vault is not live.

## Reading a position

- `stakes(user, stakingToken)` returns the tuple above. Field `0` is the staked amount; field `7` (`stakeMonthIndex`) is the calendar-month anchor for every date the user cares about. Field `4` (`stakeTime`) is the raw stake timestamp — do **not** compute the lock end from it by adding six months; see `timing-and-fees.md`.
- A position is empty when `amount == 0`.

## Reward tokens — a pool can have several

`accruedReward` and `claimReward` are **per reward token**. There is no "claim everything" call.

**The only valid source is the registry's `reward_tokens` field.** Use it.

### Do NOT use `poolRewardTokens` as the reward-token list

The contract exposes `poolRewardTokens(stakingToken, i)`, and it looks like the natural on-chain enumeration. **It is incomplete by construction and will silently hide live rewards from users.**

That array is only written by the V3-era `fundRewardPool`. Pools funded before V3 have reward tokens that are still accruing and still claimable but were never added, and the V3 migration deliberately did not backfill them. Accrual is read from a different mapping (`rewardPoolBalances`), so a token can pay out forever while being absent from the array.

Measured on Base mainnet, 2026-08-07:

| Pool | `poolRewardTokens` says | Actually also paying |
|---|---|---|
| FADED `0x21F9…3fEB` | 1 token (USDC) | **FADED itself — 19,791,666/mo, 475,000,000 total**, `isRewardTokenForPool` returns `false` |
| BWIL `0xd830…f289` | 5 tokens | **BWIL itself — 11,875,000/mo, 285,000,000 total**, `isRewardTokenForPool` returns `false` |

An agent that enumerated the array on the FADED pool would report USDC only and miss the single largest reward stream in that pool.

`isRewardTokenForPool(pool, token)` has the same defect — a `false` return is **not** evidence the pool doesn't pay that token.

**If the registry is unreachable:** tell the user you cannot confirm their full reward list right now and send them to https://pantheonvaults.com. A partial list presented as complete is worse than no list. You may still claim a specific reward token if the user names one — `accruedReward` and `claimReward` work correctly for any token, listed or not.

## Revert codes — translate honestly, never guess

| Selector | Error | Tell the user |
|---|---|---|
| `0x2083cd40` | InvalidPool() | This vault isn't active on-chain. Don't retry; check pantheonvaults.com. |
| `0xea2d0505` | NotYetEarning() | Rewards aren't claimable yet — claiming opens at 00:00 UTC on the 1st of the second calendar month after you staked. Give the date. |
| `0x5aa9184d` | NoRewardToClaim() | Nothing to claim for that reward token right now (already claimed, or nothing accrued yet). |
| `0xfb348942` | NoActiveStake() | This wallet has no active stake in that vault. |
| `0xfa499066` | InvalidLockMonths(uint16) | The term must be exactly 6 months. This is a bug in the request — do not retry with a different number. |
| `0x1f2a2005` | ZeroAmount() | The stake amount was zero. |
| `0x7cac15fa` | StakeAlreadyActive() | This wallet already has an active stake in that vault. Pantheon allows one position per wallet per vault; add to it on pantheonvaults.com. |
| `0x3498ce58` | RestakeCooldownNotFinished() | This wallet unstaked from that vault recently and must wait 7 days before staking again. |

**Which error you get on a pool that doesn't exist depends on the call.** `stake` checks the pool first and reverts `InvalidPool` (`0x2083cd40`). `claimReward` checks the *position* first, so an unknown pool reverts `NoActiveStake` (`0xfb348942`), not `InvalidPool`. Don't read `NoActiveStake` from a claim as proof the vault is fine.

Any other revert: report the raw selector and link the user to pantheonvaults.com support. Do not improvise an explanation.
