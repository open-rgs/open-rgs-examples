# 🎰 Classic Slots

A 5×3, 10-payline video slot with wilds and a scatter that triggers free spins.
The point of this example is the **safe shape**: the entire feature — base spin
plus any free spins — is resolved and paid in **one atomic settle**, at the bet
of the trigger spin.

```bash
cd games/slots-classic
bun run dev          # boots an RGS on :8080
```

```bash
bun run play --game slots-classic
```

## How the math works

- 10 fixed paylines, left-to-right, with `W` (wild) substituting.
- 3+ `SCAT` anywhere awards 10–20 free spins (FS pay 2×).
- **The free spins are simulated inside `play()` and added to the same
  multiplier** — `multiplier × bet` settles once. No `carry`, no cross-round
  state, no second money movement.

Math: [`maths/slots-classic.lua`](maths/slots-classic.lua). RTP ≈ 94%
(sim-verified), with `host.mark` splitting base vs free-spin contribution.

## Why it's safe (and slots-meta isn't)

Because the payout is **lump-sum at the trigger bet**, there's nothing to
exploit:

- No bet-switching — the free-spin value is fixed to the spin that triggered it.
- No rollback farming — there's no persistent progress to keep when a round
  reverses; the round is one settle that rolls back cleanly.

[`slots-meta`](../slots-meta) defers the payout across rounds, which is where
all the danger comes from. See [docs/slots.md](../../docs/slots.md) for the full
contrast.

## Math-test it

```bash
bun run sim --game slots-classic              # RTP + base/FS split
bun run sim --game slots-classic --spins 1e6  # tighter CI
```
