# 📈 Crash

A rising multiplier that can bust at any moment. Each `hold` advances the curve
one tick; survive and the multiplier rises, bust and it's gone. Cash out to lock
in the current value. Under the hood it's the same survival ladder as Chicken
Road, drawn as a curve — plus an honest lesson about server timers.

```bash
cd games/crash
bun run dev          # boots an RGS on :8080
```

```bash
bun run play --game crash --steps 8
```

## How the math works

Each tick survives with probability `p` (volatility), so after `t` surviving
ticks the multiplier is the fair `m_t = RTP / p^t`. Math:
[`maths/crash.lua`](maths/crash.lua).

### Why there's no "live" cash-out

A real crash game cashes out at the multiplier showing the instant you click —
which needs a server-side clock to know where the curve is *right now*. open-rgs
deliberately has **no in-process timers** (autoclose is external-trigger only,
ADR-003). So here the round advances one **server-validated** tick per `hold`
step (the multiplier is computed by the server, never claimed by the client),
and cashing out is just closing at the last survived tick. The certifiable
core — a fair survival ladder — is exactly what's implemented; a production
live-crash adds a trusted time oracle in front of it.

| param | default | range | meaning |
|-------|---------|-------|---------|
| `volatility` | medium | low / medium / high | survival per tick (0.985 → 0.94) |

- **RTP:** 99% · **Max win:** capped 1,000,000× · **Round type:** complex

## Math-test it

```bash
bun run sim --game crash --compare       # RTP flat across cash-out depth
```

See [docs/math-testing.md](../../docs/math-testing.md).
