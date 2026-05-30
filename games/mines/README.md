# 💣 Mines

The canonical **complex round** (open → step → close) and the canonical
**survival ladder**. Reveal safe tiles on a 5×5 grid to ratchet the multiplier;
cash out before you hit a mine.

```bash
cd games/mines
bun run dev          # boots an RGS on :8080
```

Play a few steps then cash out (the harness cashes after `--steps`):

```bash
bun run play --game mines --steps 4 --params '{"mines":3}'
```

## How the math works

`M` mines hide on 25 tiles. After `k` safe reveals the multiplier is the **fair**
value `m_k = RTP / P(survive k)`, so the expected value of cashing out at any `k`
is exactly RTP — early or late doesn't change the edge. A mine wipes the round;
cashing out is a `closeRound` (gated on `is_terminal`). Math:
[`maths/mines.lua`](maths/mines.lua).

This game also demonstrates:
- **JSON round-state** (`{mines, revealed, busted}`) via the lua-kit prelude.
- **`settle-at-current` autoclose** — an abandoned round banks its safe tiles.

| param | default | range | meaning |
|-------|---------|-------|---------|
| `mines` | 3 | 1 – 24 | more mines → steeper climb, higher variance |

- **RTP:** 99% · **Max win:** capped 1,000,000× · **Round type:** complex

## Math-test it

```bash
bun run sim --game mines
bun run sim --game mines --compare       # RTP flat across cash-out depth
```

The `--compare` table shows `cash-1`, `cash-3`, `cash-5`, `cash-10` and `random`
all landing on RTP — that's the constant-EV property. See
[docs/math-testing.md](../../docs/math-testing.md).
