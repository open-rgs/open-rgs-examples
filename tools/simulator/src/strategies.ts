// Strategy-aware Monte-Carlo for the example games.
//
// The shipped @open-rgs/simulator drives complex rounds with a generic "first"
// or "random" action picker — fine for measuring a constant-EV ladder, useless
// for a game whose RTP depends on HOW it's played (blackjack). This module adds
// the missing piece: named strategies and a `compare` that runs them side by
// side, which is exactly how you'd math-test these games (see spec 08).
//
// A Strategy looks at the decoded round state + the awaiting hint and either
// returns the next PlayerAction, or "stop" to cash out (CLOSE) now.

import type { ComplexMath, SimpleMath, AwaitingHint, PlayerAction } from "@open-rgs/contract";

const MAX_STEPS = 300;

// ── stats ────────────────────────────────────────────────────────────────────

export interface Stats {
  spins: number;
  rtp: number;
  std: number;
  se: number;
  ci95: [number, number];
  verdict: "pass" | "warn" | "fail";
  hitRate: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
}

export function computeStats(mults: number[], declaredRtp: number): Stats {
  const n = mults.length || 1;
  const mean = mults.reduce((a, b) => a + b, 0) / n;
  const variance = mults.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const se = std / Math.sqrt(n);
  const delta = Math.abs(declaredRtp - mean);
  let verdict: Stats["verdict"];
  if (se === 0) verdict = delta < 1e-9 ? "pass" : "fail";
  else if (delta <= 1.96 * se) verdict = "pass";
  else if (delta <= 2.576 * se) verdict = "warn";
  else verdict = "fail";
  const sorted = [...mults].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))] ?? 0;
  const hits = mults.reduce((a, m) => a + (m > 0 ? 1 : 0), 0);
  return {
    spins: mults.length,
    rtp: mean,
    std,
    se,
    ci95: [mean - 1.96 * se, mean + 1.96 * se],
    verdict,
    hitRate: hits / n,
    max: sorted[n - 1] ?? 0,
    p50: pct(50),
    p90: pct(90),
    p99: pct(99),
  };
}

// ── action helpers + strategies ───────────────────────────────────────────────

export type Strategy = (
  decoded: any,
  awaiting: AwaitingHint,
  history: PlayerAction[],
  rng: () => number,
) => PlayerAction | "stop";

/** Generic "advance" action: the awaiting type, plus its first option (mines /
 *  tower pick a tile; chicken / crash carry no value). */
function advance(awaiting: AwaitingHint): PlayerAction {
  const opts = awaiting.options;
  if (opts && opts.length > 0) return { type: awaiting.type, value: opts[0] };
  return { type: awaiting.type };
}

// Survival-ladder strategies (mines / tower / chicken-road / crash). For these
// games EV is the same at every cash-out point, so every strategy below should
// measure the same RTP — that's the property `--compare` demonstrates.
const cashAfter = (k: number): Strategy => (_d, awaiting, history) =>
  history.length >= k ? "stop" : advance(awaiting);
const randomLadder: Strategy = (_d, awaiting, history, rng) =>
  history.length >= 1 && rng() < 0.4 ? "stop" : advance(awaiting);

// Cash-out depth shouldn't change the RTP — that's the point. (We stop short of
// a "never cash" strategy: on Mines/Tower that's an all-or-nothing lottery whose
// EV is still RTP but needs astronomically many spins to measure — a caveat
// covered in docs/math-testing.md rather than shown as a misleading row here.)
const LADDER: Record<string, Strategy> = {
  "cash-1": cashAfter(1),
  "cash-3": cashAfter(3),
  "cash-5": cashAfter(5),
  "cash-10": cashAfter(10),
  random: randomLadder,
};

// Blackjack strategies. Here strategy is everything: basic ≈ declared RTP, the
// others give it away.
function handValue(cards: number[]): { total: number; soft: boolean } {
  let total = 0, aces = 0;
  for (const v of cards) { total += v; if (v === 11) aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}

/** Hit/stand-only basic strategy, dealer stands on 17. dealerUp: 11 = ace. */
function basicMove(total: number, soft: boolean, dealerUp: number): "hit" | "stand" {
  if (soft) {
    if (total >= 19) return "stand";
    if (total === 18) return dealerUp >= 2 && dealerUp <= 8 ? "stand" : "hit";
    return "hit";
  }
  if (total >= 17) return "stand";
  if (total >= 13) return dealerUp <= 6 ? "stand" : "hit";
  if (total === 12) return dealerUp >= 4 && dealerUp <= 6 ? "stand" : "hit";
  return "hit";
}

const bjAct = (value: "hit" | "stand"): PlayerAction => ({ type: "act", value });
const BLACKJACK: Record<string, Strategy> = {
  basic: (d) => {
    const { total, soft } = handValue(d.player as number[]);
    return bjAct(basicMove(total, soft, (d.dealer as number[])[0]!));
  },
  "stand-always": () => bjAct("stand"),
  "hit-always": () => bjAct("hit"),
  random: (_d, _a, _h, rng) => bjAct(rng() < 0.5 ? "hit" : "stand"),
};

/** Strategy sets per complex game. */
export const COMPLEX_STRATEGIES: Record<string, Record<string, Strategy>> = {
  mines: LADDER,
  tower: LADDER,
  "chicken-road": LADDER,
  crash: LADDER,
  blackjack: BLACKJACK,
};

/** Parameter presets per simple game — `--compare` sweeps these to show RTP is
 *  flat across the player's choices. */
export const SIMPLE_PRESETS: Record<string, { label: string; params: Record<string, unknown> }[]> = {
  limbo: [
    { label: "target 1.5×", params: { target: 1.5 } },
    { label: "target 2×", params: { target: 2 } },
    { label: "target 5×", params: { target: 5 } },
    { label: "target 50×", params: { target: 50 } },
  ],
  dice: [
    { label: "under 25", params: { target: 25, over: false } },
    { label: "under 50", params: { target: 50, over: false } },
    { label: "under 75", params: { target: 75, over: false } },
    { label: "over 50", params: { target: 50, over: true } },
  ],
  plinko: [
    { label: "risk low", params: { risk: "low" } },
    { label: "risk medium", params: { risk: "medium" } },
    { label: "risk high", params: { risk: "high" } },
  ],
};

// ── run loops ─────────────────────────────────────────────────────────────────

/** Simple game: play() once per spin, optionally with params. */
export async function runSimple(
  math: SimpleMath,
  spins: number,
  declaredRtp: number,
  params?: Record<string, unknown>,
): Promise<Stats> {
  const mults: number[] = new Array(spins);
  const ctx = { mode: "default", ...(params ? { params } : {}) };
  for (let i = 0; i < spins; i++) {
    const out = await Promise.resolve(math.play(undefined, ctx));
    mults[i] = out.multiplier;
  }
  return computeStats(mults, declaredRtp);
}

/** Complex game: open → step* (driven by `strategy`) → close, per spin. */
export async function runComplex(
  math: ComplexMath,
  strategy: Strategy,
  spins: number,
  declaredRtp: number,
  stratRng: () => number,
  params?: Record<string, unknown>,
): Promise<Stats> {
  const mults: number[] = new Array(spins);
  const ctx = { mode: "default", ...(params ? { params } : {}) };
  for (let i = 0; i < spins; i++) {
    const open = await Promise.resolve(math.open(undefined, ctx));
    let state = open.state;
    let awaiting = open.awaiting;
    const history: PlayerAction[] = [];
    let steps = 0;
    while (awaiting && steps < MAX_STEPS) {
      let decoded: any = {};
      try { decoded = JSON.parse(state); } catch { /* leave {} */ }
      const decision = strategy(decoded, awaiting, history, stratRng);
      if (decision === "stop") {
        if (await Promise.resolve(math.isTerminal(state))) break;
        // not closeable yet — fall through and advance instead of stalling
      }
      const action = decision === "stop" ? advance(awaiting) : decision;
      const step = await Promise.resolve(math.step(state, action));
      state = step.state;
      awaiting = step.awaiting;
      history.push(action);
      steps++;
    }
    const close = await Promise.resolve(math.close(state));
    mults[i] = close.multiplier;
  }
  return computeStats(mults, declaredRtp);
}
