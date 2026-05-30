# 🎲 Dice

Classic over/under dice. A roll lands uniformly in `[0, 100)`; you pick a target
and a direction, and the payout follows the win chance. Same constant-EV engine
as Limbo, exposed as a probability instead of a multiplier.

```bash
cd games/dice
bun run dev          # boots an RGS on :8080
```

```bash
bun run play --game dice --params '{"target":25,"over":false}'
```

## How the math works

The roll is uniform in `[0, 100)`. For a target `T` and direction, the win
chance is `T/100` (under) or `(100−T)/100` (over), and the payout is set from it:

```
payout = RTP / win_chance     ⇒     EV = win_chance · payout = RTP
```

Sliding the target trades win frequency against payout size but never moves the
house edge. Math: [`maths/dice.lua`](maths/dice.lua).

| param | default | range | meaning |
|-------|---------|-------|---------|
| `target` | 50.0 | 0.01 – 99.99 | the threshold |
| `over` | false | boolean | `true` = win by rolling **over** the target |

- **RTP:** 99% · **Max win:** 10,000× · **Round type:** simple

## Math-test it

```bash
bun run sim --game dice
bun run sim --game dice --compare        # RTP flat across target & direction
```

See [docs/math-testing.md](../../docs/math-testing.md).
