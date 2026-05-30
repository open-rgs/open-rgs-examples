# 🔺 Plinko

A ball bounces down rows of pegs into a bucket. There's no decision to make —
it's pure variance — so the interesting part is the **payout table**, which is
*solved* to the target RTP rather than guessed.

```bash
cd games/plinko
bun run dev          # boots an RGS on :8080
```

```bash
bun run play --game plinko --params '{"rows":16,"risk":"high"}'
```

## How the math works

The ball takes `rows` left/right bounces, landing in bucket `b` with binomial
probability `C(rows,b) / 2^rows`. We pick a relative payout **shape** (edges
high, centre low) and scale the whole table by one constant `k` so that:

```
Σ  P(b) · payout(b)  =  RTP
```

That is, the table is integrated to 0.99 — change the risk level and the shape
steepens, but the normalisation keeps RTP fixed. Math:
[`maths/plinko.lua`](maths/plinko.lua).

| param | default | range | meaning |
|-------|---------|-------|---------|
| `rows` | 16 | 8 – 20 | number of peg rows |
| `risk` | medium | low / medium / high | steepness of the payout shape |

- **RTP:** 99% · **Max win:** 10,000× · **Round type:** simple

## Math-test it

```bash
bun run sim --game plinko
bun run sim --game plinko --compare      # RTP flat across every risk level
```

See [docs/math-testing.md](../../docs/math-testing.md).
