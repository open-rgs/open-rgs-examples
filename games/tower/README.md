# 🗼 Tower

A survival ladder with **per-row choice** and a constant per-step hazard. Climb
row by row, picking one tile per row; a safe pick raises the multiplier, a fatal
pick ends the run. Cash out any time after the first row.

```bash
cd games/tower
bun run dev          # boots an RGS on :8080
```

```bash
bun run play --game tower --steps 5
```

## How the math works

Each row has `tiles` cells, `danger` of them fatal, so survival per row is
`p = (tiles − danger) / tiles` and the multiplier after climbing `r` rows is the
fair `m_r = RTP / p^r`. Constant EV at every height — Mines with a *constant*
hazard instead of a shrinking one. The danger layout is fixed at `open`
(provably fair). Math: [`maths/tower.lua`](maths/tower.lua).

| param | default | range | meaning |
|-------|---------|-------|---------|
| `rows` | 8 | 1 – 20 | tower height |
| `tiles` | 3 | 2 – 6 | cells per row |
| `danger` | 1 | 1 – tiles−1 | fatal cells per row |

- **RTP:** 99% · **Max win:** capped 100,000× · **Round type:** complex

## Math-test it

```bash
bun run sim --game tower --compare       # RTP flat across cash-out depth
```

See [docs/math-testing.md](../../docs/math-testing.md).
