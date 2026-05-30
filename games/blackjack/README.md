# 🃏 Blackjack

The odd one out — on purpose. Every other game here has an RTP fixed by the math.
Blackjack's RTP is set by **how you play**, which makes it the example for
*strategy testing*.

```bash
cd games/blackjack
bun run dev          # boots an RGS on :8080
```

```bash
bun run play --game blackjack --steps 3
```

## How the math works

Standard blackjack: infinite deck (cards drawn with replacement), dealer stands
on all 17 (S17), blackjack pays 3:2, **hit/stand only**. There's no fair-
multiplier trick — the house edge emerges from the rules and the player's
decisions. Math: [`maths/blackjack.lua`](maths/blackjack.lua).

- **Play basic strategy** → RTP ≈ **97.4%** (the declared figure, verified by the
  simulator). Hit until you bust → far worse.
- **Double and split are omitted.** Both require taking a *second* wager
  mid-round, which the single open→close money flow of a complex round doesn't
  model (you'd open the extra stake as its own transaction). That omission costs
  ~2% vs the famous ~99.5% of full basic strategy — itself a useful lesson.

- **RTP:** 97.4% (under basic strategy) · **Max win:** 2.5× · **Round type:** complex

## Math-test it

This is the whole point: a generic simulator measures nonsense here, so you must
drive it with the reference strategy.

```bash
bun run sim --game blackjack --strategy basic    # ≈ declared RTP
bun run sim --game blackjack --compare           # basic passes, others don't
```

```text
strategy         RTP        Δ          verdict
basic          97.46%    +0.06%       ✓ pass
stand-always   83.97%   -13.42%       ✗ fail
hit-always     35.36%   -62.04%       ✗ fail
random         70.58%   -26.82%       ✗ fail
```

Only `basic` reaches the declared RTP, and nothing beats it — which is exactly
what "no strategy can exploit this game" looks like. (Running plain
`bun run sim --game blackjack` uses the stock simulator's generic picker, which
reads as a *fail* — expected.) See
[docs/math-testing.md](../../docs/math-testing.md).
