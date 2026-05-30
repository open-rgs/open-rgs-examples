# Breaking the games: an antifraud red-team

These examples ship with an adversarial end-to-end harness in
[`tools/attack`](../tools/attack). It boots each game's **real server**
(`createServer` + binary-msgpack transport) and attacks it through the actual
[`@open-rgs/client`](https://www.npmjs.com/package/@open-rgs/client) over a
WebSocket — exactly the surface a remote attacker has. No internal shortcuts: if
an exploit works here, it works against a deployed server.

```bash
bun run attack                 # whole battery, all games
bun run attack --game mines    # one game
```

The one question it exists to answer:

> **Can a player mint money, double-spend, or get paid for a loss through the
> protocol?**

## The instrument: a ledger-conservation invariant

The harness wallet records every debit and credit with its round id, so each
test asserts the invariant an antifraud team actually cares about:

```
finalBalance == startBalance − Σ debits + Σ credits
```

and, separately, that **no credit is ever issued at multiplier 0** (no paying
for a loss). A win raising the balance is fine — *conservation*, not a balance
ceiling, is the invariant. (An early version of the harness got this wrong and
flagged a legitimate win as an "exploit"; the lesson is in the git history.)

## Attack battery

| # | Attack | Severity | What it tries |
|---|--------|----------|---------------|
| A1 | Bet / priceMultiplier injection | CRIT/HIGH | out-of-range, negative, fractional, 1e9 bets — wager more than allowed or confuse the debit |
| A2 | Hostile params | CRIT (money) + MED (robustness) | null, `{}`, arrays, NaN, 1e308, `__proto__`, path-ish strings into `ctx.params` |
| A3 | Double-settle replay | CRIT | reuse one idempotency key across 25 retried spins — must credit at most once |
| A4 | Lifecycle abuse | HIGH/MED | double-open, forged action type, close-before-terminal, step-after-close |
| A5 | Ladder invariant | CRIT | hammer a survival ladder 300 steps × 15 seeds — a busted round must pay **0**, payout must respect the cap |
| A6 | Conservation | CRIT | 150 mixed rounds, assert the ledger identity holds exactly |

## Results

**Every money invariant holds, on every game.** Across the battery:

- **Bet/priceMultiplier injection — all blocked.** `@open-rgs/core` validates
  `betIndex` and `priceMultiplier` as integers in range *before* any debit
  (`INVALID_BET`). You cannot wager money you don't have or a fractional/negative
  stake.
- **Double-settle — blocked.** A repeated idempotency key returns the original
  receipt; 25 replays of a winning spin moved money exactly once.
- **Busted round pays zero — holds.** Across 15 deterministic seeds per ladder,
  driven to bust, every busted round settled at ×0. No "smuggle a payout out of
  a dead round."
- **Cap respected — holds.** No payout exceeded `maxWinMultiplier × bet`.
- **Ledger conserved — holds.** Over 150 mixed rounds per game the wallet
  balance equals `start − debits + credits` to the cent, with zero unfunded
  credits.

The house cannot be beaten through the protocol on any of these games. That's
mostly a credit to `@open-rgs/core` — the orchestrator owns bet validation,
idempotency, the max-win cap, multiplier sanitization (NaN/Infinity fail
closed), and per-session operation locking. The games inherit it.

## What the red-team *did* find (and what we fixed)

### FIXED — null/non-primitive param crashed any round (DoS)

**The bug:** every game read client params like
`if ctx.params.target then x = tonumber(ctx.params.target) end`. wasmoon marshals
a JSON/msgpack **`null` as a truthy userdata sentinel**, not Lua `nil` — so the
guard passed, then `tonumber(<userdata>)` threw inside the VM bridge and the
round died with `INTERNAL_ERROR`. A remote client could crash *any* round that
reads a param by sending `{ "<field>": null }`. All 7 param-reading games were
affected (blackjack, which reads none, was immune).

**No money impact** — it fails the round before money moves — but it's a clean
remote crash / log-spam vector, and it's exactly the untrusted-input mistake an
examples repo should *not* teach.

**The fix:** a safe param reader, [`packages/lua-kit/src/params.lua`](../packages/lua-kit/src/params.lua),
injected as a prelude. `params.num/str/bool` accept **only** a real
number/string/boolean (rejecting userdata/null, tables, NaN, ±Infinity,
out-of-range) and fall back to a default otherwise. Every game now reads params
through it, and the harness's param-injection test is a permanent regression
guard (it sends `null`/`{}`/`[]`/NaN on every field and asserts no
`INTERNAL_ERROR` + money conserved).

### KNOWN — a sequence-dependent INTERNAL_ERROR in the Lua runtime (MED, no money impact)

After the fix above, the harness can still provoke an `INTERNAL_ERROR` from the
**complex** games under a *specific multi-round sequence* of hostile params
(empty-object then array values across consecutive rounds). We bisected it:

- It does **not** reproduce in isolation, only after an accumulating sequence.
- It does **not** reproduce with bare `loadLuaMath` + live JS objects — it needs
  the full server + WebSocket + msgpack-decode path.
- It is a **robustness / DoS** finding, not a money one: the harness's CRIT
  money verdict (`MONEY conserved under hostile params`) passes even while
  driving the exact crash sequence — ledger identity holds, no minting, no
  unfunded credit. The crash aborts the round *before* money moves.

This lives **below the game math** — in how the transport/wasmoon layer marshals
certain msgpack-decoded nested values into the VM — so the games can't fully fix
it from Lua. It's reported (MED) rather than papered over with a fragile guess.
A production deployment would defend the boundary by **rejecting non-primitive
param values at the transport edge** before they reach the math VM; that belongs
in core, and is filed upstream. The harness classifies it correctly: a crash
that conserves money is a hardening gap, not a theft.

> Reporting honestly beats a green checkmark. The harness prints money exploits
> (CRIT/HIGH) and robustness findings (MED/LOW) in separate sections, and only
> a money breach sets a non-zero exit code.

## A note on the math (not protocol) attacks

Two math properties were measured separately (see
[math-testing.md](math-testing.md)), since "break it" includes "break the RTP":

- **Settled vs theoretical RTP.** The simulator measures the *float* multiplier;
  production settles to integer minor units with banker's rounding (ADR-002). At
  bets ≥ 1.00 the drift is ~0.00%. At the **minimum bet (0.20)** the coarser
  rounding makes the settled RTP wander measurably from theoretical — a real,
  if small, effect worth a cert lab's attention.
- **Ride-to-the-end variance.** A "never cash out" strategy on Mines/Tower is a
  jackpot-or-nothing lottery whose EV is still the declared RTP but needs
  *hundreds of millions* of spins to converge — at 150k spins the measured
  settled RTP read 82% (a −17% sampling shortfall), with the max-win cap **never
  firing** (the deep tail is rarer than the cap). The constant-EV property is
  intact; the lesson is that high-variance tails need far more spins to certify.

## Re-running

```bash
bun run attack                       # full battery
bun run attack --game blackjack      # one game
```

Exit code is non-zero **only** if a CRIT/HIGH money invariant falls. MED/LOW
robustness findings are reported but don't fail the run.
