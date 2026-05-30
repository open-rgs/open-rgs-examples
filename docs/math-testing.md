# How to math-test these games

Every game here ships with a declared **RTP** (return to player). This guide is
about the question a math reviewer, a QA engineer, or a regulator actually asks:

> *Is the declared RTP true, and can a player beat it?*

The short version: run the simulator.

```bash
bun run sim --game limbo            # quick report
bun run sim --game mines --compare  # every strategy, side by side
bun run sim --game blackjack --compare
```

The rest of this page explains what those numbers mean and why some games can
be certified with a single number while others can't.

---

## 1. What RTP is, and how we measure it

RTP is the expected fraction of stakes returned to the player over the long run:

```
RTP = E[payout] / bet
```

A house edge of 1% is an RTP of 0.99. There's no closed form for most games, so
we measure it by **Monte-Carlo**: play the math a few million times with a
seeded PRNG and average the result. The simulator ([`@open-rgs/simulator`] plus
the strategy engine in [`tools/simulator`](../tools/simulator)) does this and
prints a verdict.

```text
🚀 Limbo — declared RTP 99.00%
  measured 98.99%  ✓ PASS   95% CI [98.97%, 99.01%]
  hit rate 49.47%   max ×2.00   p99 ×2.00
  outcomes: loss 50.53% · win 49.47%
  1,000,000 spins · 36s
```

The **verdict** isn't just a printed delta. It computes the standard error of
the measured RTP (`stdDev(per-spin return) / √n`) and a confidence interval,
then reports:

| verdict | meaning |
|---------|---------|
| ✓ `pass` | declared RTP is within the 95% CI of what we measured |
| ⚠ `warn` | within 99% but not 95% — run more spins |
| ✗ `fail` | declared RTP is significantly off from measured |

A `fail` is either a math bug or a wrong declared number. A `warn` usually just
means the estimate is still noisy — see [§4](#4-variance-how-many-spins).

> **Reproducibility.** Outcomes come from a seeded PRNG (`--seed`), so a run is
> repeatable. That PRNG is *simulator-only* — `loadLuaMath` rejects it for
> real-money play and demands a certified CSPRNG. See
> [open-rgs spec 03](https://open-rgs.dev/math).

---

## 2. The key idea: two families of game

The games here split cleanly into two groups, and they're tested completely
differently.

### Family A — constant-EV games (everything except Blackjack)

Limbo, Dice, Plinko, Mines, Tower, Chicken Road and Crash are all built so that
**the RTP does not depend on the player's choices.** This isn't an accident;
it's the defining trick of "provably fair" originals.

Take the survival ladders (Mines, Tower, Chicken Road, Crash). After you've
survived `k` steps, the multiplier on offer is set to the *fair* value:

```
m_k = RTP / P(survive k steps)
```

So the expected value of cashing out right now is

```
E[cash out at k] = P(survive k) · m_k = P(survive k) · RTP / P(survive k) = RTP
```

— the same number for **every** `k`. It cancels. Cashing out early, late, or at
random all have expected value RTP. Limbo and Dice are the one-step version of
the same identity (`payout = RTP / win_chance`); Plinko bakes it into a payout
table solved so `Σ P(bucket)·payout(bucket) = RTP`.

This has three consequences that make Family A easy to trust:

1. **The simulator measures the true RTP no matter how it plays.** It doesn't
   need a smart strategy — any strategy gives the same answer.
2. **You can prove the property** by running several strategies and watching the
   RTP stay flat (`--compare`, below).
3. **No player can beat the house.** There's no sequence of decisions with EV
   above RTP, because every decision point already has EV exactly RTP.

```text
$ bun run sim --game mines --compare

💣 Mines — strategy comparison  (declared 99.00%)

  strategy        RTP        Δ        hit       max     verdict
  cash-1        99.03%    +0.03%    88.03%    ×1.13    ✓ pass
  cash-3        99.57%    +0.57%    67.34%    ×1.48    ✓ pass
  cash-5        99.12%    +0.12%    49.63%    ×2.00    ✓ pass
  cash-10       99.92%    +0.92%    19.97%    ×5.00    ✓ pass
  random        98.15%    -0.85%    72.89%    ×10.35   ⚠ warn

  → every strategy lands on the same RTP: cashing out early or late
    can't beat (or lose to) the house edge.
```

For the one-step games, `--compare` instead sweeps the player's *parameter* (the
target, the dice threshold, the risk level) and shows the RTP is flat across all
of them:

```text
$ bun run sim --game dice --compare

🎲 Dice — RTP is independent of the player's choice  (declared 99.00%)

  strategy        RTP        Δ        hit       max     verdict
  under 25      99.40%    +0.40%    25.10%    ×3.96    ✓ pass
  under 50      99.00%    -0.00%    50.00%    ×1.98    ✓ pass
  under 75      99.12%    +0.12%    75.09%    ×1.32    ✓ pass
  over 50       99.06%    +0.06%    50.03%    ×1.98    ✓ pass

  → the slider trades win-chance for payout, never the house edge.
```

### Family B — strategy-dependent games (Blackjack)

Blackjack has **no fair-multiplier trick.** Its return is whatever the player's
decisions make it. So "the RTP" is meaningless without saying *which strategy*,
and a generic simulator that picks arbitrary actions measures garbage.

You test it by encoding the **reference strategy** (here, hit/stand-only basic
strategy) and proving two things: (a) the reference strategy matches the
declared RTP, and (b) nothing beats it.

```text
$ bun run sim --game blackjack --compare

🃏 Blackjack — strategy comparison  (declared 97.40%)

  strategy         RTP         Δ         hit       max     verdict
  basic          97.46%     +0.06%     51.99%    ×2.50    ✓ pass
  stand-always   83.97%    -13.42%     43.20%    ×2.50    ✗ fail
  hit-always     35.36%    -62.04%     17.15%    ×2.50    ✗ fail
  random         70.58%    -26.82%     36.24%    ×2.50    ✗ fail

  → only 'basic' reaches the declared RTP; everything else gives the
    house more. RTP here is a property of the strategy, not the math.
```

This is the open-rgs spec's "strategy testing" and "exploit testing" in
miniature (see [spec 08](https://open-rgs.dev) — `compare` / `fuzz`): you want
the reference strategy at the declared RTP and **no** other strategy above it.
If `fuzz` ever found a strategy that beat the declared RTP, that's an exploit.

> Running the *default* `bun run sim --game blackjack` (no `--compare`) drives
> the stock simulator's generic action picker, which plays "stand-always" and
> therefore reads as a **fail**. That's expected — it's the whole reason this
> game needs strategy-aware testing.

---

## 3. Telling the two families apart

| | Family A (constant-EV) | Family B (strategy-dependent) |
|---|---|---|
| Games | Limbo, Dice, Plinko, Mines, Tower, Chicken Road, Crash | Blackjack |
| RTP is… | a fixed number, baked into the math | an outcome of how it's played |
| Generic simulator | measures the true RTP | measures nonsense |
| How to verify | any strategy / any param → same RTP | reference strategy → declared; nothing beats it |
| Can a player beat it? | provably no | only by playing the optimal strategy (which *is* the declared RTP) |

If you're designing a new game, knowing which family it's in tells you how to
test it — and, honestly, Family A is the better place to be: a game whose RTP is
strategy-proof is far easier to certify.

---

## 4. Variance & how many spins

The measured RTP is an average, so its precision is `stdDev / √n`. Two practical
rules fall out of that:

- **High-variance games need more spins.** A bet that wins 0.1% of the time for
  ×990 has the same RTP as a coin flip but a huge standard deviation, so its
  estimate is still wobbling at a million spins. Watch the 95% CI width, not
  just the point estimate.
- **Some strategies are far noisier than others.** In the Mines table above,
  `cash-10` jumps around more than `cash-1` — it's a rarer, bigger win. The
  extreme case is a **"never cash out"** strategy on Mines or Tower: you only
  win by clearing *every* safe tile, a ~1-in-2300 jackpot of ×2277. Its EV is
  still exactly RTP, but you'd need *hundreds of millions* of spins to see that
  in the average. (That's why the simulator's strategy set stops at `cash-10`
  rather than including a "ride to the end" row that would just look broken.)

Crank the spins for a tighter read — at the cost of wall-clock time:

```bash
bun run sim --game limbo --spins 1e7     # ~6 minutes; CI shrinks ~3×
```

> **Performance.** The Lua runs in a WASM VM at ~tens of microseconds per call,
> so ~1M spins is tens of seconds and `1e7` is a multi-minute certification run.
> The defaults (100k, or 50k for `--compare`) are for quick interactive checks.
> For billion-spin certification you'd shard across worker processes — out of
> scope for these examples, see [spec 08](https://open-rgs.dev).

---

## 5. Two honest caveats baked into the examples

**Provably-fair vs. these demos.** A production originals game commits to a
server seed + client seed up front so a player can later verify each outcome
wasn't tampered with. These examples use the injected RNG directly and skip the
seed-commitment dance — the *distributions* are identical, but the cryptographic
audit trail is a layer you'd add on top.

**Crash has no live cash-out — on purpose.** A real crash game cashes out at the
multiplier showing the instant you click, which needs a server-side clock to
know "where is the curve right now." open-rgs deliberately has **no in-process
timers** (autoclose is external-trigger only, [ADR-003]). So Crash here advances
one server-validated tick per `hold` step (the multiplier is computed by the
server, never claimed by the client), and cashing out is just closing at the
last survived tick. The certifiable *core* — a fair survival ladder — is exactly
what's implemented; a production live-crash adds a trusted time oracle in front.

---

## 6. How the simulator drives a round

For a simple game it just calls `play()` N times. For a complex game it runs the
real round protocol with a **strategy** deciding each step:

```ts
const open = await math.open(carry, ctx)
let state = open.state, awaiting = open.awaiting
while (awaiting) {
  const decision = strategy(JSON.parse(state), awaiting, history)
  if (decision === "stop" && await math.isTerminal(state)) break   // cash out
  const step = await math.step(state, decision)
  state = step.state; awaiting = step.awaiting
}
const { multiplier } = await math.close(state)   // settle
```

A strategy is just `(decodedState, awaiting, history) => action | "stop"`. The
ladder strategies (`cash-1`, `cash-3`, …) only decide *when* to cash; the
blackjack strategies (`basic`, …) decide *what* to do. They live in
[`tools/simulator/src/strategies.ts`](../tools/simulator/src/strategies.ts) —
add your own there.

---

## 7. Per-game cheat sheet

| Game | Family | Declared | How to verify |
|------|--------|----------|---------------|
| Limbo | A | 99% | `sim --game limbo --compare` — flat across targets |
| Dice | A | 99% | `sim --game dice --compare` — flat across target/direction |
| Plinko | A | 99% | `sim --game plinko --compare` — flat across risk levels |
| Mines | A | 99% | `sim --game mines --compare` — flat across cash-out depth |
| Tower | A | 99% | `sim --game tower --compare` |
| Chicken Road | A | 99% | `sim --game chicken-road --compare` |
| Crash | A | 99% | `sim --game crash --compare` |
| Blackjack | B | 97.4% | `sim --game blackjack --compare` — only `basic` ≈ declared |

---

[`@open-rgs/simulator`]: https://www.npmjs.com/package/@open-rgs/simulator
[ADR-003]: https://open-rgs.dev
