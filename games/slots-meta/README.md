# 🎯 Meta Slots

A slot with **meta-progression**: scatters don't trigger a feature on the spin
they land — they fill a persistent meter. Every scatter is **+1 progress**; at
**10 progress** the next spin pays a **bonus** and the meter resets. Base line
wins pay every spin as usual.

This is the **dangerous shape**, and the example exists to show how to make it
safe. Read [docs/slots.md](../../docs/slots.md) for the full threat model.

```bash
cd games/slots-meta
bun run dev          # boots an RGS on :8080 — on the bet-aware MetaPlatform
```

```bash
bun run play --game slots-meta          # watch progress accumulate
bun run attack:meta                     # the red-team (from repo root)
```

## Why a deferred payout is exploitable

The bonus is **earned over many cheap spins and cashed on one spin** that pays
`BONUS × bet`. open-rgs math is **currency-blind** — it never sees the bet — so
the math *cannot* defend two attacks:

1. **Bet-switching.** Accumulate 9 progress at the 0.20 min bet, then trigger
   the 10th at the 10.00 max bet — a 50× value transfer the math can't even see.
2. **Rollback farming.** Gain progress, then have the round rolled back: if
   money and progress don't revert *together*, you keep the progress for free
   (or keep a bonus payout and replay its trigger).

## The defense lives in the adapter, not the math

[`@open-rgs-examples/meta-platform`](../../packages/meta-platform) is bet-aware
and owns two invariants:

1. **Stake-lock.** When progress goes 0→positive, it pins `lockedBet` to that
   spin's bet. Any later spin at a different bet, while progress > 0, is
   **rejected** — you accumulate and cash at one stake. The lock clears when the
   meter resets.
2. **Atomic `(balance, carry)` + snapshot rollback.** Money and progress are
   written in one record; `rollback(roundId)` restores **both** from a
   pre-round snapshot. You can't reverse the money and keep the progress.

The math ([`maths/slots-meta.lua`](maths/slots-meta.lua)) just honestly advances
progress in `carry` and pays the bonus exactly once per crossing — it always
writes `lockedBet=nil` and lets the adapter own the lock (single source of
truth, since a forked client could lie).

## Proven robust

`bun run attack:meta` boots the real server on the MetaPlatform and runs:

| | attack | result |
|---|--------|--------|
| E1 | bet-switch at progress 1 | ✓ rejected, no state moved |
| E1b | bonus pays at locked bet | ✓ pays at ×20, not the ×1000 a switch wanted |
| E2 | rollback a progress gain | ✓ progress reverts with the money |
| E3 | rollback the bonus round | ✓ restores balance **and** progress |
| E4 | replay the bonus spin | ✓ credited once |
| E6 | bet-switch at progress 9 (trigger) | ✓ rejected, no state moved |
| E7 | rollback a bogus round id | ✓ safe no-op |
| E5 | 600-spin conservation | ✓ balance stays sane |

RTP ≈ 94% (base ≈ 80% line wins + ≈ 14% amortised bonus), sim-verified:

```bash
bun run sim --game slots-meta
```
