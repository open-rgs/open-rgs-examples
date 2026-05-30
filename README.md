# open-rgs examples

A gallery of worked casino games built on [**open-rgs**](https://github.com/open-rgs/open-rgs) —
each one boots with a single Bun file and is math-testable with the simulator.
MIT, and meant to be read.

**→ Browse the gallery: [examples.open-rgs.dev](https://examples.open-rgs.dev)**

Eight games, two shared tools, one in-memory wallet. They cover the whole
open-rgs surface: simple and complex rounds, Lua math, the wallet adapter, the
binary-msgpack transport, and RTP simulation.

## Pick a game, cd in, run it

```bash
bun install                  # once, from the repo root (Bun workspaces)

cd games/limbo
bun run dev                  # = bun src/index.ts — boots an RGS on :8080
```

Then, from the repo root, drive a real round end-to-end or test the math:

```bash
bun run play --game limbo    # one round over the real WebSocket client
bun run sim  --game limbo    # measure the RTP
```

## The games

| | Game | Round | RTP | What it shows |
|---|------|-------|-----|---------------|
| 🚀 | [Limbo](games/limbo) | simple | 99% | the simplest constant-EV fair draw |
| 🎲 | [Dice](games/dice) | simple | 99% | win-chance ⇆ payout, same edge |
| 🔺 | [Plinko](games/plinko) | simple | 99% | binomial buckets, payout table solved to RTP |
| 💣 | [Mines](games/mines) | complex | 99% | the canonical survival ladder + JSON state |
| 🗼 | [Tower](games/tower) | complex | 99% | a ladder with per-row choice |
| 🐔 | [Chicken Road](games/chicken-road) | complex | 99% | a single-action ladder with difficulty |
| 📈 | [Crash](games/crash) | complex | 99% | a tick-based ladder (and why live cash-out needs a timer) |
| 🃏 | [Blackjack](games/blackjack) | complex | 97.4% | the strategy-**dependent** counter-example |
| 🎰 | [Classic Slots](games/slots-classic) | simple | 94% | reels + free spins, resolved **atomically** (safe shape) |
| 🎯 | [Meta Slots](games/slots-meta) | simple | 94% | scatter→+1 progress, 10→bonus; deferred payout, **hardened** |

Most are **constant-EV**: the RTP doesn't depend on how you play, which is what
makes them certifiable with a single number. Blackjack is the exception that
proves the rule — its RTP is whatever your strategy earns
([how to math-test these games](docs/math-testing.md)). The two **slots** carry a
different lesson: Classic resolves its feature atomically and is safe by
construction, while Meta defers a bonus payout across rounds — which invites
bet-switching and rollback farming, defended by a bet-aware adapter. That story
is [**docs/slots.md**](docs/slots.md), and the whole antifraud red-team is
[**docs/security.md**](docs/security.md).

## Layout

```
open-rgs-examples/
├── packages/
│   ├── mock-platform/   # 🧩 a PlatformAdapter you can read in one sitting —
│   │                    #    holds balance, dedupes, and logs every wallet call
│   ├── meta-platform/   # 🔒 bet-aware adapter for slots-meta: stake-lock +
│   │                    #    atomic (balance,carry) commit with rollback
│   └── lua-kit/         #    JSON + safe-param readers injected into the maths' Lua
├── games/
│   ├── limbo/ dice/ plinko/                  # simple rounds
│   ├── mines/ tower/ chicken-road/ crash/    # survival ladders
│   ├── blackjack/                            # strategy-dependent
│   └── slots-classic/ slots-meta/            # slots (atomic vs deferred payout)
│       ├── maths/<game>.lua    # the game math (Lua)
│       ├── src/manifest.ts     # loadLuaMath + defineGame
│       ├── src/index.ts        # createServer({ manifest, platform, transport })
│       └── game.json           # gallery metadata
├── tools/
│   ├── simulator/       # bun run sim  --game <name> [--compare]
│   ├── play/            # bun run play --game <name>
│   └── attack/          # 🗡️ bun run attack  ·  bun run attack:meta (antifraud red-team)
└── docs/                #    gallery site + math-testing + slots + security guides
```

Each game is self-contained: `maths/<game>.lua` is the math, `src/index.ts`
wires it to a wallet and a transport, and that's the entire server.

## The shared tools

```bash
bun run play --game mines --steps 4     # boot in-process + drive one round,
                                        # watching every wallet call scroll by
bun run sim  --game mines --compare     # every strategy, side by side
bun run sim  --game blackjack --strategy basic
bun run docs:build                      # regenerate docs/dist for the site
```

- **`bun run dev`** (in a game dir) — boots just that game's server.
- **`bun run play --game X`** — boots a game in-process and plays one round over
  the real `@open-rgs/client`, so you see client → transport → orchestrator →
  Lua → wallet work together.
- **`bun run sim --game X`** — Monte-Carlo RTP. Add `--compare` to prove the
  ladders are constant-EV and that only basic strategy reaches blackjack's RTP.

## Math testing

The simulator answers the question that matters: *is the declared RTP true, and
can a player beat it?* The two families of game are tested differently —

```bash
bun run sim --game dice --compare        # constant-EV: RTP flat across choices
bun run sim --game blackjack --compare   # strategy-dependent: only basic passes
```

Read [**docs/math-testing.md**](docs/math-testing.md) for the full story: RTP as
expected value, confidence intervals and verdicts, the constant-EV fair-
multiplier identity, strategy/exploit testing, and how many spins you need.

## Breaking the games (antifraud red-team)

`tools/attack` boots each game's **real server** and attacks it over the
WebSocket protocol — trying to mint money, double-spend, over-climb a ladder,
forge state, or smuggle a payout out of a busted round. Every test asserts a
hard money-conservation invariant.

```bash
bun run attack                  # whole battery, all games
bun run attack:meta             # the slots-meta red-team (bet-switch + rollback)
```

Across the board: **no money exploit holds** — core blocks bet injection, dedupes
replays, caps wins, and conserves the ledger to the cent; the meta-slot's
deferred bonus is defended by a stake-lock and atomic money+state rollback. The
findings (and the one runtime robustness gap that has no money impact) are
written up in [**docs/security.md**](docs/security.md) and
[**docs/slots.md**](docs/slots.md).

## Built on open-rgs

These examples use the published packages — [`@open-rgs/core`](https://www.npmjs.com/package/@open-rgs/core),
[`@open-rgs/contract`](https://www.npmjs.com/package/@open-rgs/contract),
[`@open-rgs/client`](https://www.npmjs.com/package/@open-rgs/client),
[`@open-rgs/simulator`](https://www.npmjs.com/package/@open-rgs/simulator) — and
build their own minimal wallet adapter on top. For the engine itself, see
[open-rgs](https://github.com/open-rgs/open-rgs) and the docs at
[open-rgs.dev](https://open-rgs.dev).

## License

MIT — see [LICENSE](LICENSE).
