# 🐔 Chicken Road

Get the chicken across the road, one lane at a time. A **single-action** survival
ladder: each `cross` survives with probability `p` (set by difficulty), the
multiplier ticks up, and getting hit loses everything. The only decision is when
to stop.

```bash
cd games/chicken-road
bun run dev          # boots an RGS on :8080
```

```bash
bun run play --game chicken-road --steps 6 --params '{"difficulty":"hard"}'
```

## How the math works

After crossing `n` lanes the multiplier is the fair `m_n = RTP / p^n`. Difficulty
dials `p` (and the lane cap): lower difficulty crosses more lanes for small
steps; daredevil rarely survives but each lane pays big. Same constant-EV math
as Crash, with discrete lanes instead of a continuous curve. Math:
[`maths/chicken-road.lua`](maths/chicken-road.lua).

| param | default | range | meaning |
|-------|---------|-------|---------|
| `difficulty` | medium | easy / medium / hard / daredevil | survival per lane (0.95 → 0.60) |

- **RTP:** 99% · **Max win:** capped 1,000,000× · **Round type:** complex

## Math-test it

```bash
bun run sim --game chicken-road --compare    # RTP flat across cash-out depth
```

See [docs/math-testing.md](../../docs/math-testing.md).
