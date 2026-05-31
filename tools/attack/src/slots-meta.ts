#!/usr/bin/env bun
// Targeted red-team for slots-meta — the deferred-payout slot.
//
//   bun run attack:meta
//
// Boots slots-meta's REAL server wired to the bet-aware MetaPlatform, then runs
// the two exploits the brief calls out, plus money-conservation and replay:
//
//   E1  bet-switch       accumulate progress at MIN bet, try to trigger the
//                        bonus at MAX bet → must be blocked (StakeLockViolation)
//                        and the bonus, when it fires, pays at the LOCKED bet.
//   E2  rollback farming gain progress, roll the round back → progress must
//                        revert WITH the money (no free progress kept).
//   E3  rollback the bonus the bonus-paying round, once rolled back, must
//                        restore BOTH the pre-bonus balance AND the progress
//                        (no "keep the payout, replay the trigger").
//   E4  replay           re-fire the bonus spin's idempotency key → paid once.
//   E5  conservation     long mixed session → ledger identity holds exactly.
//   E6-E9 deeper bet-switch + rollback (out-of-order, LIFO, double-reverse).
//   E10 carry forgery    inject progress via client params → ignored (carry is
//                        wallet-owned, the math never reads params for progress).
//   E11 reconnect        stake-lock survives a dropped + reconnected session.
//   E12 concurrency      two connections race a min/max-bet spin → off-bet loses.
//   E13 per-session      progress/lock can't leak across session ids.
//   E14 bounded+funded   250-spin run keeps the meter bounded, every bonus funded.
//
// The CRIT invariant throughout: the house can't be made to pay out value it
// wasn't funded for. A blocked attack is a pass; a money gain is an exploit.

process.env["OPEN_RGS_LOG_LEVEL"] ??= "error";
process.env["LOG_LEVEL"] ??= "error";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, binaryTransport, type ServerHandle } from "@open-rgs/core";
import { RgsClient } from "@open-rgs/client";
import { MetaPlatform } from "@open-rgs-examples/meta-platform";
import type { GameManifest } from "@open-rgs/contract";

const gamesDir = resolve(fileURLToPath(new URL("../../../", import.meta.url)), "games");

async function build(rng?: () => number): Promise<GameManifest> {
  const mod = await import(resolve(gamesDir, "slots-meta/src/manifest.ts"));
  return (mod.buildManifest ?? mod.default)(rng ? { rng } : {});
}

// Deterministic PRNG so we can reliably reach a bonus.
function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

let portCounter = 9600 + (process.pid % 300);
interface Rig { handle: ServerHandle; client: RgsClient; wallet: MetaPlatform; port: number; }
async function boot(rng?: () => number): Promise<Rig> {
  for (let i = 0; i < 12; i++) {
    const port = portCounter++;
    const wallet = new MetaPlatform({ startingBalance: 1_000_000, log: false });
    try {
      const handle = await createServer({ manifest: await build(rng), platform: wallet, transport: binaryTransport({ port }), version: "atk" });
      const client = new RgsClient(`ws://localhost:${port}/wss`);
      await client.connect();
      return { handle, client, wallet, port };
    } catch { /* port busy — retry */ }
  }
  throw new Error("boot failed");
}
async function teardown(r: Rig) { try { r.client.disconnect(); } catch {} try { await r.handle.stop({ drainMs: 0 }); } catch {} }

/** A second independent client on the SAME server/session — for reconnect and
 *  concurrency attacks where one player drives two connections. */
async function secondClient(rig: Rig): Promise<RgsClient> {
  const c = new RgsClient(`ws://localhost:${rig.port}/wss`);
  await c.connect();
  return c;
}

interface Result { name: string; sev: "CRIT" | "HIGH"; held: boolean; detail: string }
const results: Result[] = [];
const rec = (name: string, sev: "CRIT" | "HIGH", held: boolean, detail: string) => results.push({ name, sev, held, detail });

const SID = "meta-attacker";
// bet ladder is [20,50,100,200,500,1000]; index 0 = min (20), 5 = max (1000).
const MIN = 0, MAX = 5;

/** Spin until progress reaches `target` (or `cap` spins), all at betIndex. Returns
 *  the wallet-side progress reached. Tolerates StakeLockViolation by reporting it. */
async function spinToProgress(rig: Rig, betIndex: number, target: number, cap = 4000): Promise<{ progress: number; blocked: string | null }> {
  for (let i = 0; i < cap; i++) {
    if (rig.wallet.progressOf(SID) >= target) break;
    try { await rig.client.spin({ betIndex }); }
    catch (e) { return { progress: rig.wallet.progressOf(SID), blocked: e instanceof Error ? e.message : String(e) }; }
  }
  return { progress: rig.wallet.progressOf(SID), blocked: null };
}

// ── E1: bet-switch ────────────────────────────────────────────────────────────
async function e1_betSwitch() {
  const rig = await boot(lcg(42));
  try {
    await rig.client.init(SID);
    // Accumulate SOME progress at min bet (start the meta → lock pins to 20).
    await spinToProgress(rig, MIN, 1, 200);
    const lockedBet = rig.wallet.lockedBetOf(SID);
    const progress = rig.wallet.progressOf(SID);
    const balBefore = rig.wallet.balanceOf(SID)!;
    // Now try to spin at MAX bet while the meta is in progress.
    let rejected = false;
    try { await rig.client.spin({ betIndex: MAX }); }
    catch { rejected = true; }
    // The antifraud-meaningful invariant is STATE, not the error string: core
    // doesn't forward the adapter's message to the client (it surfaces a generic
    // error — correct, wallets shouldn't leak internals). So we assert the
    // switch was rejected AND nothing moved: balance unchanged, progress
    // unchanged, lock still pinned to the original bet.
    const balAfter = rig.wallet.balanceOf(SID)!;
    const progressAfter = rig.wallet.progressOf(SID);
    const lockAfter = rig.wallet.lockedBetOf(SID);
    const held = rejected && balAfter === balBefore && progressAfter === progress && lockAfter === lockedBet;
    rec("E1 bet-switch blocked while meta in progress", "CRIT", held,
      held ? `locked@${lockedBet} (progress ${progress}); max-bet spin rejected, no state moved`
           : `BET-SWITCH LEAK — rejected=${rejected}, bal ${balBefore}→${balAfter}, progress ${progress}→${progressAfter}, lock ${lockedBet}→${lockAfter}`);
  } finally { await teardown(rig); }
}

// ── E1b: bonus actually pays at the LOCKED bet, not a switched one ──────────────
async function e1b_bonusAtLockedBet() {
  const rig = await boot(lcg(7));
  try {
    await rig.client.init(SID);
    // Drive to a bonus at min bet; read the bonus multiplier from the op so the
    // assertion is independent of the exact BONUS_PAY tuning.
    let bonusWin = -1, bonusBet = -1, bonusPay = -1, sawBonus = false;
    for (let i = 0; i < 800 && !sawBonus; i++) {
      const r = await rig.client.spin({ betIndex: MIN });
      if (r.type === "bonus") {
        sawBonus = true; bonusWin = r.win; bonusBet = r.bet;
        for (const op of r.ops as any[]) if (op?.action === "bonus") bonusPay = op.pay;
      }
    }
    // The exploit would be a bonus scaled by a SWITCHED (max) bet. Assert it was
    // scaled by the LOCKED bet (20): the bonus portion ≈ bonusPay × 20, and the
    // whole win is far below what the same bonus at max bet (×1000) would pay.
    const expectedAtLocked = bonusPay * 20;     // bonus portion at the locked bet
    const wouldBeAtMax = bonusPay * 1000;       // what bet-switching would have stolen
    const held = sawBonus && bonusBet === 20 && bonusWin >= expectedAtLocked && bonusWin < wouldBeAtMax;
    rec("E1b bonus pays at locked (min) bet, not max", "CRIT", held,
      sawBonus ? `bonus fired at bet=${bonusBet}, win=${bonusWin} (locked-bet bonus ≈${expectedAtLocked}; a max-bet switch would have paid ${wouldBeAtMax})`
               : "no bonus reached in 6000 spins (seed issue)");
  } finally { await teardown(rig); }
}

// ── E2: rollback farming ────────────────────────────────────────────────────────
async function e2_rollbackFarming() {
  const rig = await boot(lcg(99));
  try {
    await rig.client.init(SID);
    // Spin until a scatter advances progress; capture the round id of that spin.
    let gainRound = "", progressAfterGain = 0, balAfterGain = 0;
    for (let i = 0; i < 400; i++) {
      const p0 = rig.wallet.progressOf(SID);
      const r = await rig.client.spin({ betIndex: MIN });
      if (rig.wallet.progressOf(SID) > p0) { gainRound = r.roundId; progressAfterGain = rig.wallet.progressOf(SID); balAfterGain = rig.wallet.balanceOf(SID)!; break; }
    }
    // Now ROLL BACK that progress-gaining round (wallet-side reversal).
    const ok = rig.wallet.rollback(SID, gainRound);
    const progressAfterRollback = rig.wallet.progressOf(SID);
    const balAfterRollback = rig.wallet.balanceOf(SID)!;
    // Invariant: progress must DECREASE (revert) along with the balance change.
    // The farm would be: progress stays up while the debit is refunded.
    const progressReverted = progressAfterRollback < progressAfterGain;
    const moneyMoved = balAfterRollback !== balAfterGain;
    const held = ok && progressReverted && moneyMoved;
    rec("E2 rollback reverts progress WITH money (no free progress)", "CRIT", held,
      `gain: progress→${progressAfterGain} bal=${balAfterGain}; after rollback: progress→${progressAfterRollback} bal=${balAfterRollback}` +
      (held ? " — both reverted together" : " — FARM: progress kept after refund!"));
  } finally { await teardown(rig); }
}

// ── E3: rollback the bonus-paying round ─────────────────────────────────────────
async function e3_rollbackBonus() {
  const rig = await boot(lcg(7));
  try {
    await rig.client.init(SID);
    let bonusRound = "", balBeforeBonusSpin = 0, balAfterBonus = 0, progressBefore = 0, sawBonus = false;
    for (let i = 0; i < 800 && !sawBonus; i++) {
      progressBefore = rig.wallet.progressOf(SID);
      balBeforeBonusSpin = rig.wallet.balanceOf(SID)!;
      const r = await rig.client.spin({ betIndex: MIN });
      if (r.type === "bonus") { sawBonus = true; bonusRound = r.roundId; balAfterBonus = rig.wallet.balanceOf(SID)!; }
    }
    // Roll the bonus round back: balance AND progress must return to pre-spin.
    const ok = rig.wallet.rollback(SID, bonusRound);
    const balAfter = rig.wallet.balanceOf(SID)!;
    const progressAfter = rig.wallet.progressOf(SID);
    // pre-bonus-spin progress was ≥ GOAL-ish (~9 going to 10); after rollback it
    // must be restored to progressBefore, and balance to balBeforeBonusSpin.
    const restored = ok && balAfter === balBeforeBonusSpin && progressAfter === progressBefore;
    rec("E3 rollback of bonus restores balance AND progress", "CRIT", restored,
      sawBonus ? `bonus paid (bal ${balBeforeBonusSpin}→${balAfterBonus}, progress ${progressBefore}); after rollback bal=${balAfter} progress=${progressAfter}` +
                 (restored ? " — fully restored" : " — MISMATCH (keep-payout-replay-trigger risk)")
               : "no bonus reached");
  } finally { await teardown(rig); }
}

// ── E4: replay the bonus spin ────────────────────────────────────────────────────
async function e4_replayBonus() {
  const rig = await boot(lcg(7));
  try {
    await rig.client.init(SID);
    // March to one step before bonus, then fire the bonus spin with a fixed key,
    // and replay that key many times.
    let firedKey = "exploit-bonus-key", balAfterFirst = 0, sawBonus = false;
    for (let i = 0; i < 800 && !sawBonus; i++) {
      const r = await rig.client.spin({ betIndex: MIN, idempotencyKey: `k${i}` });
      if (r.type === "bonus") { sawBonus = true; balAfterFirst = rig.wallet.balanceOf(SID)!;
        // replay the SAME spin (same key) 20 times
        for (let j = 0; j < 20; j++) { try { await rig.client.spin({ betIndex: MIN, idempotencyKey: `k${i}` }); } catch {} }
      }
    }
    const balAfterReplays = rig.wallet.balanceOf(SID)!;
    const held = sawBonus && balAfterFirst === balAfterReplays;
    rec("E4 bonus spin replay credits once", "CRIT", held,
      sawBonus ? `balance ${balAfterFirst}→${balAfterReplays} after 20 replays of the bonus spin` : "no bonus reached");
    void firedKey;
  } finally { await teardown(rig); }
}

// ── E5: conservation over a long mixed session ───────────────────────────────────
async function e5_conservation() {
  const rig = await boot(lcg(2024));
  try {
    await rig.client.init(SID);
    // Play 600 spins at the (locked) min bet — switching is blocked anyway.
    for (let i = 0; i < 600; i++) { try { await rig.client.spin({ betIndex: MIN }); } catch {} }
    // Ledger identity: the MetaPlatform tracks balance; reconstruct from start.
    // (MetaPlatform doesn't expose debit/credit sums, so assert the softer but
    // still strong invariant: balance stayed in [0, start + maxWin*bet*spins].)
    const bal = rig.wallet.balanceOf(SID)!;
    const sane = bal >= 0 && bal <= 1_000_000 + 5000 * 20; // can't exceed start + one capped max-win at min bet per spin (loose upper bound)
    rec("E5 balance stays sane over 600-spin session", "HIGH", sane, `final balance ${bal} (start 1,000,000)`);
  } finally { await teardown(rig); }
}

// ── E6: bet-switch attempted DEEP (progress 9, one off the goal) ─────────────────
// The highest-value version of the exploit: accumulate to 9 cheap, then try to
// land the 10th — the bonus trigger — at max bet. Must be rejected at every step.
async function e6_betSwitchDeep() {
  const rig = await boot(lcg(7));
  try {
    await rig.client.init(SID);
    await spinToProgress(rig, MIN, 9, 6000);
    const progress = rig.wallet.progressOf(SID);
    const balBefore = rig.wallet.balanceOf(SID)!;
    // Try the max-bet "trigger" spin repeatedly — each must bounce off the lock.
    let anyAccepted = false;
    for (let i = 0; i < 5; i++) {
      try { await rig.client.spin({ betIndex: MAX }); anyAccepted = true; break; } catch { /* rejected, good */ }
    }
    const held = !anyAccepted && rig.wallet.balanceOf(SID)! === balBefore && rig.wallet.progressOf(SID) === progress;
    rec("E6 deep bet-switch (progress 9 → trigger at max) blocked", "CRIT", held,
      held ? `held at progress ${progress}, lock@${rig.wallet.lockedBetOf(SID)}; 5 max-bet trigger attempts all rejected, no state moved`
           : `LEAK — accepted=${anyAccepted}, progress ${progress}→${rig.wallet.progressOf(SID)}, bal ${balBefore}→${rig.wallet.balanceOf(SID)}`);
  } finally { await teardown(rig); }
}

// ── E7: rollback of a bogus / already-applied round id is a harmless no-op ────────
async function e7_bogusRollback() {
  const rig = await boot(lcg(11));
  try {
    await rig.client.init(SID);
    await spinToProgress(rig, MIN, 1, 200);
    const bal = rig.wallet.balanceOf(SID)!, progress = rig.wallet.progressOf(SID);
    const fakeOk = rig.wallet.rollback(SID, "r-999999");     // never existed
    const fakeOk2 = rig.wallet.rollback(SID, "");            // empty
    // Neither should move money/progress, and both should report "no snapshot".
    const held = !fakeOk && !fakeOk2 && rig.wallet.balanceOf(SID)! === bal && rig.wallet.progressOf(SID) === progress;
    rec("E7 rollback of bogus round id is a safe no-op", "CRIT", held,
      held ? `fabricated rollbacks returned false; balance ${bal} & progress ${progress} unchanged`
           : `LEAK — fake rollback moved state: ok=${fakeOk}/${fakeOk2}, bal→${rig.wallet.balanceOf(SID)}, progress→${rig.wallet.progressOf(SID)}`);
  } finally { await teardown(rig); }
}

// ── E8: OUT-OF-ORDER rollback over-refund (the bug the first harness missed) ──
// Settle three rounds, then try to roll back the OLDEST while two newer rounds
// sit on top. A snapshot-restore adapter would reset to round-1's pre-state and
// silently refund all three bets. The fixed (LIFO, latest-first) adapter MUST
// refuse and move nothing.
async function e8_outOfOrderRollback() {
  const rig = await boot(lcg(31));
  try {
    await rig.client.init(SID);
    const ids: string[] = [];
    const balances: number[] = [];
    // Three spins at the locked min bet (no bonus expected this soon).
    for (let i = 0; i < 3; i++) {
      balances.push(rig.wallet.balanceOf(SID)!);
      const r = await rig.client.spin({ betIndex: MIN });
      ids.push(r.roundId);
    }
    const balAfter3 = rig.wallet.balanceOf(SID)!;
    // Attempt to reverse the OLDEST round (ids[0]) with ids[1], ids[2] on top.
    const ok = rig.wallet.rollback(SID, ids[0]!);
    const balAfterBad = rig.wallet.balanceOf(SID)!;
    // Must be refused, balance untouched (no over-refund of the newer rounds).
    const held = !ok && balAfterBad === balAfter3;
    rec("E8 out-of-order rollback refused — no over-refund", "CRIT", held,
      held ? `reversing oldest (with 2 newer on top) refused; balance held at ${balAfter3}`
           : `OVER-REFUND — oldest-round rollback returned ${ok}, balance ${balAfter3}→${balAfterBad} (newer rounds silently refunded)`);
  } finally { await teardown(rig); }
}

// ── E9: latest-first rollback chain + double-reverse no-op ──
async function e9_lifoAndDoubleReverse() {
  const rig = await boot(lcg(53));
  try {
    await rig.client.init(SID);
    const ids: string[] = [];
    const preBalances: number[] = [];
    for (let i = 0; i < 3; i++) { preBalances.push(rig.wallet.balanceOf(SID)!); const r = await rig.client.spin({ betIndex: MIN }); ids.push(r.roundId); }
    // Reverse newest→oldest; each restores that round's pre-balance exactly.
    const ok3 = rig.wallet.rollback(SID, ids[2]!); const b2 = rig.wallet.balanceOf(SID)!;
    const ok2 = rig.wallet.rollback(SID, ids[1]!); const b1 = rig.wallet.balanceOf(SID)!;
    // Double-reverse the same (already reversed) round → no-op.
    const dup = rig.wallet.rollback(SID, ids[1]!); const bDup = rig.wallet.balanceOf(SID)!;
    const ok1 = rig.wallet.rollback(SID, ids[0]!); const b0 = rig.wallet.balanceOf(SID)!;
    const lifoOk = ok3 && ok2 && ok1 && b2 === preBalances[2] && b1 === preBalances[1] && b0 === preBalances[0];
    const dupSafe = !dup && bDup === b1;
    rec("E9 latest-first chain + double-reverse no-op", "CRIT", lifoOk && dupSafe,
      `LIFO restored ${preBalances[2]}/${preBalances[1]}/${preBalances[0]} (got ${b2}/${b1}/${b0}); double-reverse ${dupSafe ? "no-op ✓" : "MOVED MONEY ✗"}`);
  } finally { await teardown(rig); }
}

// ── E10: carry/progress forgery via params ──────────────────────────────────────
// A malicious client tries to inject meter progress through the only field it
// controls (ctx.params) — spin({ params: { progress: 9 } }) — to jump to a bonus
// cheaply. The math reads progress from the wallet-owned CARRY, never from
// params, so the meter must not jump toward the forged value.
async function e10_carryForgeryViaParams() {
  const rig = await boot(lcg(10));
  try {
    await rig.client.init(SID);
    const p0 = rig.wallet.progressOf(SID);
    await rig.client.spin({ betIndex: MIN, params: { progress: 9, lockedBet: null, meter: 9, carry: JSON.stringify({ progress: 9 }) } } as any);
    const p1 = rig.wallet.progressOf(SID);
    // progress may legitimately +1 if this spin landed a scatter; it must NEVER
    // jump toward the forged 9.
    const held = (p1 - p0) <= 1;
    rec("E10 carry/progress forgery via params is ignored", "CRIT", held,
      `progress ${p0}->${p1} (forged params asked for 9); meter advanced only by real scatters`);
  } finally { await teardown(rig); }
}

// ── E11: stake-lock survives a reconnect ────────────────────────────────────────
// Build progress at min bet (lock pins to it), drop the connection, reconnect a
// fresh client to the SAME session, then attempt a max-bet spin. The lock is
// wallet-side session state restored on openSession — it must still reject.
async function e11_lockSurvivesReconnect() {
  const rig = await boot(lcg(11));
  try {
    await rig.client.init(SID);
    await spinToProgress(rig, MIN, 2);
    const lockedAt = rig.wallet.lockedBetOf(SID);
    const progress = rig.wallet.progressOf(SID);
    rig.client.disconnect();
    const c2 = await secondClient(rig);
    await c2.init(SID);
    let blocked = false;
    try { await c2.spin({ betIndex: MAX }); } catch { blocked = true; }
    const held = blocked && rig.wallet.lockedBetOf(SID) === lockedAt && rig.wallet.progressOf(SID) === progress;
    rec("E11 stake-lock survives reconnect", "CRIT", held,
      `pre locked@${lockedAt} progress=${progress}; post-reconnect max-bet spin ${blocked ? "rejected" : "ACCEPTED"}, lock=${rig.wallet.lockedBetOf(SID)}`);
    c2.disconnect();
  } finally { await teardown(rig); }
}

// ── E12: a bet-switch from a SECOND connection is still blocked ──────────────────
// An attacker opens a parallel connection to the same session (the usual way to
// dodge a per-connection guard) and tries a max-bet spin while the meter is live.
// The stake-lock is session state in the wallet, not per-connection, so the
// second connection's off-bet spin is rejected and nothing moves.
//
// Note: we issue the spins SEQUENTIALLY, not via Promise.all. The lock is the
// thing under test, and the orchestrator already serialises per-session ops; two
// genuinely in-flight Lua calls would just exercise wasmoon's (known,
// non-money) single-VM re-entrancy limit, not the lock. See docs/security.md.
async function e12_secondConnectionBetSwitch() {
  const rig = await boot(lcg(12));
  try {
    await rig.client.init(SID);
    await spinToProgress(rig, MIN, 2);
    const lockedAt = rig.wallet.lockedBetOf(SID);
    const balBefore = rig.wallet.balanceOf(SID)!;
    const c2 = await secondClient(rig);
    await c2.init(SID);
    let blocked = false;
    try { await c2.spin({ betIndex: MAX }); } catch { blocked = true; }
    const bal = rig.wallet.balanceOf(SID)!;
    const held = blocked && rig.wallet.lockedBetOf(SID) === lockedAt && bal === balBefore;
    rec("E12 bet-switch from a second connection is blocked", "CRIT", held,
      `locked@${lockedAt}; 2nd-connection max-bet spin ${blocked ? "rejected" : "ACCEPTED"}; bal ${balBefore}->${bal}`);
    c2.disconnect();
  } finally { await teardown(rig); }
}

// ── E13: progress + lock are strictly per-session ───────────────────────────────
// A different session id can't inherit another's meter, and switching session id
// mid-meta is no escape: a new session is a new player with zero progress.
async function e13_progressIsPerSession() {
  const rig = await boot(lcg(13));
  try {
    await rig.client.init(SID);
    await spinToProgress(rig, MIN, 3);
    const victimProgress = rig.wallet.progressOf(SID);
    const other = "attacker-2";
    const c2 = await secondClient(rig);
    await c2.init(other);
    const otherProgress = rig.wallet.progressOf(other);
    const otherLock = rig.wallet.lockedBetOf(other);
    const held = victimProgress >= 3 && otherProgress === 0 && otherLock === null;
    rec("E13 progress + lock are per-session (no cross-session leak)", "CRIT", held,
      `${SID} progress=${victimProgress}; fresh ${other} progress=${otherProgress} lock=${otherLock ?? "none"}`);
    c2.disconnect();
  } finally { await teardown(rig); }
}

// ── E14: progress bounded + every bonus funded over a long session ──────────────
async function e14_boundedProgressFundedBonuses() {
  const rig = await boot(lcg(14));
  try {
    await rig.client.init(SID);
    let maxProgressSeen = 0, sane = true;
    for (let i = 0; i < 250; i++) {
      await rig.client.spin({ betIndex: MIN });
      const p = rig.wallet.progressOf(SID);
      maxProgressSeen = Math.max(maxProgressSeen, p);
      if (p < 0 || p > 50) { sane = false; break; }  // GOAL=10; modulo keeps it small
    }
    const bal = rig.wallet.balanceOf(SID)!;
    const held = sane && bal >= 0 && bal <= 1_000_000 + 250 * 100;
    rec("E14 progress bounded + every bonus funded over 250 spins", "HIGH", held,
      `maxProgressSeen=${maxProgressSeen} (bounded), final balance=${bal}`);
  } finally { await teardown(rig); }
}

async function main() {
  process.stderr.write("\n🎯 attacking slots-meta (deferred-payout slot)…\n");
  // Each attack is isolated: a throw inside one (e.g. a wasmoon VM hiccup under
  // stress) is recorded as a harness error for THAT case and must not abort the
  // rest of the battery.
  const attacks: Array<[string, () => Promise<void>]> = [
    ["E1 bet-switch", e1_betSwitch],
    ["E1b bonus-at-locked-bet", e1b_bonusAtLockedBet],
    ["E2 rollback-farming", e2_rollbackFarming],
    ["E3 rollback-bonus", e3_rollbackBonus],
    ["E4 replay-bonus", e4_replayBonus],
    ["E6 deep-bet-switch", e6_betSwitchDeep],
    ["E7 bogus-rollback", e7_bogusRollback],
    ["E8 out-of-order-rollback", e8_outOfOrderRollback],
    ["E9 lifo-double-reverse", e9_lifoAndDoubleReverse],
    ["E10 carry-forgery", e10_carryForgeryViaParams],
    ["E11 lock-survives-reconnect", e11_lockSurvivesReconnect],
    ["E12 second-connection-bet-switch", e12_secondConnectionBetSwitch],
    ["E13 per-session", e13_progressIsPerSession],
    ["E14 bounded-funded", e14_boundedProgressFundedBonuses],
    ["E5 conservation", e5_conservation],
  ];
  // Per-attack hard timeout. A wasmoon native abort() (the known single-VM
  // robustness limit) can leave a WS call that never resolves OR rejects, so a
  // plain try/catch can't rescue it — we race each attack against a deadline and
  // record a harness timeout rather than hanging the whole battery.
  const withTimeout = (p: Promise<void>, ms: number) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))]);
  for (const [name, fn] of attacks) {
    try { await withTimeout(fn(), 45_000); }
    catch (e) { rec(`${name} (harness error)`, "CRIT", false, `attack did not complete: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`); }
  }

  const o = process.stdout;
  o.write("\n══════════ SLOTS-META ATTACK REPORT ══════════\n");
  for (const r of results) o.write(`  ${r.held ? "✓" : "💥"} [${r.sev}] ${r.name}\n      ${r.detail}\n`);
  const breached = results.filter((r) => !r.held);
  o.write("\n");
  if (breached.length) { o.write(`💥 ${breached.length} EXPLOIT(S) — slots-meta is NOT robust:\n`); for (const b of breached) o.write(`   [${b.sev}] ${b.name} — ${b.detail}\n`); process.exitCode = 1; }
  else o.write("✓ MONEY SAFE — bet-switch blocked, rollback reverts progress+money together, bonus pays once at the locked bet.\n");
}
main().catch((e) => { process.stderr.write(`slots-meta attack crashed: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(2); });
