# Two slots, and why one needs an antifraud adapter

The repo ships two slots that look similar and are worlds apart in risk:

- **[slots-classic](../games/slots-classic)** — scatter triggers free spins,
  paid **atomically** on the trigger spin. Safe by construction.
- **[slots-meta](../games/slots-meta)** — scatter gives **+1 persistent
  progress**; 10 progress pays a **bonus**. A *deferred* payout, and deferred
  payouts are where money exploits live.

This page is about the second one: the two attacks it invites, why the game math
**cannot** defend them, and the bet-aware adapter that does.

## The shape that's safe: slots-classic

When a scatter hits in slots-classic, the math simulates the whole free-spin
round **inside the same `play()` call** and returns one multiplier:

```lua
total = base
if scatters >= 3 then
  for i = 1, free_spin_count do total = total + free_spin() end   -- all of it, now
end
return { multiplier = total, type = "freespins", ops = ... }       -- one settle
```

`core` does `multiplier × bet` and settles **once**, at the trigger bet. There's
no `carry`, no state that outlives the round. Consequences:

- **Nothing to bet-switch.** The feature's value is locked to the spin that
  triggered it — you can't earn it cheap and cash it expensive.
- **Nothing to farm on rollback.** One settle reverses cleanly; there's no
  persistent counter to keep.

The math alone is sufficient. That's the whole reason to prefer this shape when
you can.

## The shape that's dangerous: slots-meta

slots-meta defers the payout. Progress lives in `carry` and survives across
rounds:

```lua
local progress = read_progress(prev) + scatters     -- persistent, cross-round
if progress >= 10 then total = total + BONUS; progress = progress - 10 end
return { multiplier = total, carry = json.encode({ progress = progress }) }
```

Now the bonus is **earned over ~150 cheap spins and cashed on one spin** that
pays `BONUS × bet`. Two exploits follow immediately.

### Attack 1 — bet-switching ("low-balance betting")

Accumulate 9 progress at the **minimum** bet (0.20), then land the 10th — the
spin that fires the bonus — at the **maximum** bet (10.00). You funded the meter
with cheap spins and cashed it for 50× the value. A jurisdiction would call this
theft; a player calls it free money.

### Attack 2 — round rollback / farming

Wallets reverse rounds (chargebacks, reconciliation, disconnect recovery). If
the reversal isn't perfectly atomic, you farm the gap:

- **Progress farming:** gain a scatter (+1 progress), then trigger a rollback of
  that round. If the *money* refunds but the *progress* stays, you've built the
  meter for free. Repeat to 10 and collect a bonus you never paid for.
- **Bonus replay:** reach the bonus, collect the payout, then roll back the
  bonus spin. If the *balance* reverts but the *progress* doesn't (still ≥10),
  you re-trigger and collect again. Or vice-versa: keep the payout, lose nothing.

> The brief put it exactly right: *"if such a slot would happen to have a round
> rollback and a state change, it could be abused by low-balance betting."* The
> state change (progress) and the money must be one indivisible thing.

## Why the math can't fix either one

open-rgs math is **currency-blind**. The context it receives is:

```ts
SpinContext = { mode: string; params?: Record<string, unknown> }   // no bet!
```

So the math:

- **cannot see the bet** — it has no idea progress was built at 0.20 and is being
  cashed at 10.00. It returns a dimensionless multiplier; `core` multiplies by a
  bet the math never learns.
- **cannot trust `params`** — that's client-controlled. A forked client that
  passes `{ myBet: 0.20 }` is just lying.
- **cannot see the wallet ledger** — rollbacks happen upstream, outside the math
  entirely.

A defense that can't see the bet or the ledger can't defend a bet-and-ledger
exploit. **It has to live in a bet-aware server component.** In open-rgs that's
the **PlatformAdapter** — the one thing that sees the real bet *and* owns the
persisted carry.

## The defense: `@open-rgs-examples/meta-platform`

Two invariants, both in the [adapter](../packages/meta-platform/src/index.ts):

### 1. Stake-lock — kills bet-switching

The carry format is `{ progress, lockedBet }`. The adapter — not the math —
owns `lockedBet`:

```
progress 0 → >0 :  pin lockedBet to THIS spin's bet      (meta started)
progress >0 → >0 :  require bet == lockedBet, else REJECT (meta continuing)
progress    → 0 :  clear lockedBet                       (meta consumed; re-bet freely)
```

The check runs **before any money moves**, so a rejected bet-switch costs and
changes nothing. You accumulate and cash the entire meter at one stake.

### 2. Atomic `(balance, carry)` + snapshot rollback — kills farming

Money and progress are written in the **same** settle. Before applying a settle,
the adapter snapshots `(balance, carry, lock)` keyed by `roundId`;
`rollback(roundId)` restores all three together:

```ts
// before applying:
s.snapshots.set(roundId, { balance: s.balance, carry: s.carry });
// rollback:
s.balance = snap.balance; s.carry = snap.carry;   // both, or neither
```

So you can never reverse the money while keeping the progress, or gain progress
and dodge the debit — the pair moves as one unit.

## Proven, not asserted

[`tools/attack/src/slots-meta.ts`](../tools/attack/src/slots-meta.ts) boots the
real server on the MetaPlatform and runs the exploits over the WebSocket
protocol. `bun run attack:meta`:

```text
✓ [CRIT] E1  bet-switch blocked while meta in progress
             locked@20 (progress 1); max-bet spin rejected, no state moved
✓ [CRIT] E1b bonus pays at locked (min) bet, not max
             bonus fired at bet=20, win=42 (≈42 at locked bet; a max-bet switch wanted 2100)
✓ [CRIT] E2  rollback reverts progress WITH money (no free progress)
             gain: progress→1 bal=1000072; after rollback: progress→0 bal=1000000
✓ [CRIT] E3  rollback of bonus restores balance AND progress
✓ [CRIT] E4  bonus spin replay credits once
✓ [CRIT] E6  deep bet-switch (progress 9 → trigger at max) blocked
✓ [CRIT] E7  rollback of bogus round id is a safe no-op
✓ [HIGH] E5  balance stays sane over 600-spin session

✓ MONEY SAFE — bet-switch blocked, rollback reverts progress+money together,
  bonus pays once at the locked bet.
```

The CRIT invariant throughout: **the house can never be made to pay out value it
wasn't funded for.** A blocked attack is a pass; any money gain is an exploit.

## Takeaways for designing your own meta features

1. **Prefer the atomic shape.** If a feature can be resolved on the spin that
   triggers it (slots-classic), do that — it removes the whole exploit class.
2. **If you must defer, the bet-aware layer owns the safety.** Persistent
   progress that pays out later is fine *only* with a stake-lock and atomic
   money+state commit. The currency-blind math can't carry that weight.
3. **Money and game-state are one transaction.** They commit together and roll
   back together. Any seam between them is a farm.
4. **The lock's source of truth is the adapter, never the client or the math.**
   The math emits progress; the adapter derives and enforces the lock from the
   real bet it actually sees.

See also [docs/security.md](security.md) for the full antifraud harness across
all games, and [docs/math-testing.md](math-testing.md) for RTP verification.
