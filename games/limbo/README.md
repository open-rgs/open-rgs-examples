# 🚀 Limbo

The simplest provably-fair "originals" game, and the cleanest illustration of a
**constant-EV** payout. Pick a target multiplier; a result is rolled; you win
your target if the roll reaches it.

```bash
bun install          # from the repo root (workspaces), once
cd games/limbo
bun run dev          # boots an RGS on :8080  (PORT=8081 to change)
```

Drive a round and watch the whole stack (client → wire → orchestrator → Lua →
wallet), from the repo root:

```bash
bun run play --game limbo --params '{"target":3}'
```

## How the math works

A result `R` is drawn with a heavy tail so that `P(R ≥ x) = RTP / x`. You win
your chosen target `T` whenever `R ≥ T`, paying `T×`. So for **any** target:

```
EV = P(win) · T = (RTP / T) · T = RTP
```

The house edge never depends on how greedy you are — which is why the simulator
(which can't pass a target) still measures the true RTP, and why no target beats
the house. The math lives in [`maths/limbo.lua`](maths/limbo.lua).

| param | default | range | meaning |
|-------|---------|-------|---------|
| `target` | 2.0 | 1.01 – 1,000,000 | the multiplier you're aiming for |

- **RTP:** 99% · **Max win:** 1,000,000× · **Round type:** simple

## Math-test it

```bash
bun run sim --game limbo                 # RTP report
bun run sim --game limbo --compare       # RTP is flat across every target
bun run sim --game limbo --spins 1e7     # tighter CI (multi-minute run)
```

See [docs/math-testing.md](../../docs/math-testing.md) for what the numbers mean.
