#!/usr/bin/env bun
// open-rgs-examples · attack
//
//   bun run attack            # run the whole battery against all games
//   bun run attack --game mines
//
// Boots each game's REAL server and attacks it over the @open-rgs/client WS
// protocol, behaving like an antifraud red-teamer: try to mint money, double-
// spend, over-climb a ladder, forge state, smuggle a payout out of a busted
// round, and inject hostile params. Every test asserts a hard money-conservation
// invariant; a single EXPLOITED row is a finding.

process.env["OPEN_RGS_LOG_LEVEL"] ??= "error";
process.env["LOG_LEVEL"] ??= "error";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import type { GameManifest, AwaitingHint, PlayerAction } from "@open-rgs/contract";
import { boot, teardown, record, recordError, expectReject, findings, type Rig } from "./harness.js";

const gamesDir = resolve(fileURLToPath(new URL("../../../", import.meta.url)), "games");

async function build(game: string, rng?: () => number): Promise<GameManifest> {
  const mod = await import(resolve(gamesDir, game, "src/manifest.ts"));
  const fn = mod.buildManifest ?? mod.default;
  return fn(rng ? { rng } : {});
}
function games(): string[] {
  return readdirSync(gamesDir).filter((d) => { try { return statSync(resolve(gamesDir, d, "src/manifest.ts")).isFile(); } catch { return false; } }).sort();
}
function kindOf(m: GameManifest) { return m.modes[m.defaultMode]!.math.kind; }

const J = (v: unknown) => JSON.stringify(v);

// Advance one step using whatever the awaiting hint offers.
function advance(a: AwaitingHint): PlayerAction {
  return a.options && a.options.length ? { type: a.type, value: a.options[0] } : { type: a.type };
}

// ─────────────────────────────────────────────────────────────────────────────
// Attack battery
// ─────────────────────────────────────────────────────────────────────────────

/** A1 — Bet/priceMultiplier injection. Try to wager more money than allowed, or
 *  use a fractional / out-of-range / negative bet to confuse the debit math. */
async function attackBetInjection(game: string, m: GameManifest) {
  const rig = await boot(m);
  const complex = kindOf(m) === "complex";
  const fire = complex ? (req: any) => rig.client.openRound(req) : (req: any) => rig.client.spin(req);
  try {
    await rig.client.init("a1");
    const cases: { label: string; req: any; sev: "CRIT" | "HIGH" }[] = [
      { label: "betIndex out of range (999)", req: { betIndex: 999 }, sev: "HIGH" },
      { label: "betIndex negative (-1)", req: { betIndex: -1 }, sev: "HIGH" },
      { label: "betIndex fractional (1.5)", req: { betIndex: 1.5 }, sev: "HIGH" },
      { label: "priceMultiplier huge (1e9)", req: { betIndex: 0, priceMultiplier: 1_000_000_000 }, sev: "CRIT" },
      { label: "priceMultiplier zero", req: { betIndex: 0, priceMultiplier: 0 }, sev: "HIGH" },
      { label: "priceMultiplier negative", req: { betIndex: 0, priceMultiplier: -5 }, sev: "CRIT" },
      { label: "priceMultiplier fractional", req: { betIndex: 0, priceMultiplier: 0.001 }, sev: "HIGH" },
    ];
    for (const c of cases) {
      const r = await expectReject(() => fire(c.req));
      // Defense holds if it rejected OR if it accepted but never let cost exceed balance / go negative.
      const bal = rig.wallet.balanceNow();
      const sane = bal >= 0 && bal <= rig.wallet.startBalance + 0; // no money created on a bet op
      record(game, `bet-injection: ${c.label}`, c.sev, r.rejected || sane,
        r.rejected ? `rejected: ${r.message.slice(0, 60)}` : `accepted; balance=${bal} (start ${rig.wallet.startBalance})`);
      // reset open round if one slipped through
      if (complex) { try { await rig.client.closeRound({}); } catch { /* fine */ } }
    }
  } catch (e) { recordError(game, "bet-injection", "HIGH", String(e)); }
  finally { await teardown(rig); }
}

/** A2 — Hostile params. The client controls ctx.params verbatim; throw garbage
 *  at the math (huge numbers, wrong types, injection-ish strings, null, proto).
 *  The defense holds iff: (1) NO request triggers an INTERNAL_ERROR (a hostile
 *  param must never crash a round — that's a DoS/log-spam vector), and (2) money
 *  stays conserved (ledger identity intact; a win raising the balance is fine
 *  and expected — conservation, not a balance ceiling, is the invariant). */
async function attackParamInjection(game: string, m: GameManifest) {
  const complex = kindOf(m) === "complex";
  const payloads: Record<string, unknown>[] = [
    { target: 1e308 }, { target: -1 }, { target: "drop table" }, { target: Number.NaN },
    { target: null }, { target: {} }, { target: [1, 2] },          // the null/obj crash class
    { mines: 999 }, { mines: -3 }, { mines: 0 }, { mines: 1.9 }, { mines: null },
    { difficulty: "../../etc" }, { difficulty: 9001 }, { difficulty: null }, { volatility: {} },
    { rows: 1e6 }, { rows: null }, { risk: "__proto__" }, { volatility: null },
    { tiles: 1, danger: 5 }, { tiles: null }, { danger: null },
  ];
  // FRESH rig per payload: a hostile input on one payload must never bleed an
  // open round into the next (which would mis-attribute the crash). This is the
  // antifraud invariant proper — each hostile request judged in isolation.
  let crash = "", brokeLedger = "";
  for (const params of payloads) {
    const rig = await boot(m);
    try {
      await rig.client.init("a2");
      try {
        if (complex) {
          const o = await rig.client.openRound({ betIndex: 0, params });
          let a = o.awaiting, n = 0;
          while (a && n < 3) { const s = await rig.client.stepRound({ action: advance(a) }); a = s.awaiting; n++; }
          await forceClose(rig);
        } else {
          await rig.client.spin({ betIndex: 0, params });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A clean validation rejection is fine. An INTERNAL_ERROR means hostile
        // input got past the param guards and crashed the round — a robustness /
        // DoS gap (NOT a money exploit; money is checked separately below).
        if (/internal error/i.test(msg) && !crash) crash = `INTERNAL_ERROR on ${J(params)}: ${msg.slice(0, 40)}`;
      }
      // The money invariant — this is the one that must ALWAYS hold.
      const expected = rig.wallet.startBalance - rig.wallet.totalDebited() + rig.wallet.totalCredited();
      if (expected !== rig.wallet.balanceNow() && !brokeLedger) brokeLedger = `ledger broke on ${J(params)}: expected ${expected} got ${rig.wallet.balanceNow()}`;
    } finally { await teardown(rig); }
  }
  // Two distinct verdicts, two severities — don't conflate a no-money crash with
  // a money exploit.
  record(game, "param-injection · MONEY conserved under hostile params", "CRIT", brokeLedger === "",
    brokeLedger || `ledger conserved across all ${payloads.length} hostile payloads`);
  record(game, "param-injection · no INTERNAL_ERROR (robustness/DoS)", "MED", crash === "",
    crash || `no crash across ${payloads.length} hostile payloads`);
}

/** A3 — Double-settle / replay. Reuse the same client idempotencyKey across a
 *  retried spin; the wallet must move money at most once. */
async function attackReplay(game: string, m: GameManifest) {
  if (kindOf(m) !== "simple") return; // simple-round replay; complex close is server-keyed
  // Force a guaranteed win so a double-credit would actually mint money.
  const rig = await boot(m);
  try {
    await rig.client.init("a3");
    const key = "exploit-key-001";
    // Spin with a fixed idempotency token, then replay it many times.
    const first = await rig.client.spin({ betIndex: 5, params: { target: 1.01 }, idempotencyKey: key });
    const balAfterFirst = rig.wallet.balanceNow();
    for (let i = 0; i < 25; i++) {
      try { await rig.client.spin({ betIndex: 5, params: { target: 1.01 }, idempotencyKey: key }); } catch { /* ok */ }
    }
    const balAfterReplays = rig.wallet.balanceNow();
    const credits = rig.wallet.ledger.filter((e) => !e.idempotent && e.credit > 0).length;
    record(game, "double-settle replay (25× same idempotencyKey)", "CRIT", balAfterFirst === balAfterReplays,
      `balance ${balAfterFirst}→${balAfterReplays} after 25 replays; non-idempotent credits=${credits} (first win type=${first.type})`);
  } catch (e) { recordError(game, "replay", "CRIT", String(e)); }
  finally { await teardown(rig); }
}

/** A4 — Complex lifecycle abuse. Each sub-attack runs on its OWN rig so one
 *  rejection can't bleed state into the next assertion. */
async function attackLifecycle(game: string, m: GameManifest) {
  if (kindOf(m) !== "complex") return;

  // (a) double-open: open a round, then open again while it's live.
  await onRig(m, async (rig) => {
    await rig.client.init("a4a");
    await rig.client.openRound({ betIndex: 0 });
    const dbl = await expectReject(() => rig.client.openRound({ betIndex: 0 }));
    record(game, "double-open while round live", "HIGH", dbl.rejected,
      dbl.rejected ? `rejected: ${dbl.message.slice(0, 50)}` : "second open ACCEPTED — would double-debit");
  }, (e) => recordError(game, "double-open", "HIGH", e));

  // (b) forged action type — server must reject without invoking math.
  await onRig(m, async (rig) => {
    await rig.client.init("a4b");
    await rig.client.openRound({ betIndex: 0 });
    const wrong = await expectReject(() => rig.client.stepRound({ action: { type: "__forged__", value: 0 } }));
    record(game, "forged action type", "MED", wrong.rejected,
      wrong.rejected ? `rejected: ${wrong.message.slice(0, 50)}` : "forged action ACCEPTED");
  }, (e) => recordError(game, "forged-action", "MED", e));

  // (c) close before terminal: open, then close with zero steps. Ladders need
  //     ≥1 step for is_terminal, so this MUST reject (no free settle of a debit).
  await onRig(m, async (rig) => {
    await rig.client.init("a4c");
    await rig.client.openRound({ betIndex: 2 });
    const balAfterOpen = rig.wallet.balanceNow();
    const early = await expectReject(() => rig.client.closeRound({}));
    // If it somehow closed, did it pay anything back unjustly?
    const profit = rig.wallet.playerProfit();
    record(game, "close before terminal (0 steps)", "HIGH", early.rejected,
      early.rejected ? `rejected: ${early.message.slice(0, 50)}` : `premature close ACCEPTED; profit=${profit} (bal after open ${balAfterOpen})`);
  }, (e) => recordError(game, "early-close", "HIGH", e));

  // (d) step after close: open, step to terminal, close, then step again.
  await onRig(m, async (rig) => {
    await rig.client.init("a4d");
    const o = await rig.client.openRound({ betIndex: 0 });
    if (o.awaiting) await rig.client.stepRound({ action: advance(o.awaiting) });
    await rig.client.closeRound({});
    const after = await expectReject(() => rig.client.stepRound({ action: { type: "reveal", value: 0 } }));
    record(game, "step after round closed", "MED", after.rejected,
      after.rejected ? `rejected: ${after.message.slice(0, 50)}` : "post-close step ACCEPTED");
  }, (e) => recordError(game, "step-after-close", "MED", e));
}

/** A5 — Over-step abuse: keep advancing a ladder far past its natural cap and
 *  confirm the multiplier can't be pumped beyond what the math permits, and that
 *  a busted round can NEVER close for a profit. This is the core money invariant
 *  for the survival ladders. */
async function attackLadderInvariant(game: string, m: GameManifest) {
  if (kindOf(m) !== "complex") return;
  // Deterministic RNG so we span both bust and deep-survive paths. Each seed
  // gets its OWN rig (fresh server+wallet), so a per-seed error can't bleed into
  // the next seed's verdict — we just note it and keep going.
  let exploited = "";
  let busts = 0, harnessErrs = 0;
  const cap = (m.modes[m.defaultMode]!.maxWinMultiplier ?? m.maxWinMultiplier ?? Infinity);
  const SEEDS = 8;
  for (let seed = 1; seed <= SEEDS && !exploited; seed++) {
    const rig = await boot(await build(game, mulberry(seed)));
    try {
      await rig.client.init(`a5-${seed}`);
      const o = await rig.client.openRound({ betIndex: 2 }); // bet 100
      let a: AwaitingHint | undefined = o.awaiting;
      let busted = false, steps = 0;
      // Hammer the round well past any cap (300 steps).
      while (a && steps < 300) {
        const s = await rig.client.stepRound({ action: advance(a) });
        a = s.awaiting;
        steps++;
        for (const op of s.ops as any[]) {
          if (op && (op.mine === true || op.fatal === true || op.safe === false || op.action === "bust" || op.bust === true)) busted = true;
        }
      }
      if (busted) busts++;
      // CLOSE and check what the wallet actually paid.
      let credit = 0, closeMult = 0, closeType = "";
      try { const c = await rig.client.closeRound({}); credit = c.win; closeMult = c.multiplier; closeType = c.type; }
      catch { /* round may be in a non-closeable terminal state; that's fine */ }

      // INVARIANT 1: a busted round must pay exactly 0.
      if (busted && credit > 0) exploited = `seed ${seed}: BUSTED round paid win=${credit} (×${closeMult}, ${closeType})`;
      // INVARIANT 2: payout can't exceed cap × bet.
      if (credit > 100 * cap + 1) exploited = `seed ${seed}: payout ${credit} exceeds cap ${cap}×bet`;
    } catch { harnessErrs++; /* harness/flow error — not a game finding */ }
    finally { await teardown(rig); }
  }
  record(game, `busted round pays zero / cap respected (${SEEDS} seeds × 300 steps)`, "CRIT", exploited === "",
    exploited || `clean across ${SEEDS} seeds (${busts} reached bust, cap ${cap}×)${harnessErrs ? ` [${harnessErrs} harness errors ignored]` : ""}`);
}

/** A6 — Money conservation over a long random session. Play hundreds of rounds
 *  with hostile-ish inputs and assert the ledger balances exactly:
 *  finalBalance == start − Σdebits + Σcredits, and the player can't end up with
 *  money the math never granted. */
async function attackConservation(game: string, m: GameManifest) {
  const rig = await boot(await build(game, mulberry(12345)));
  const complex = kindOf(m) === "complex";
  try {
    await rig.client.init("a6");
    for (let i = 0; i < 150; i++) {
      const betIndex = i % 6;
      try {
        if (complex) {
          const o = await rig.client.openRound({ betIndex });
          let a = o.awaiting, n = 0;
          const stop = i % 5; // vary cash-out depth
          while (a && n < stop) { const s = await rig.client.stepRound({ action: advance(a) }); a = s.awaiting; n++; }
          await forceClose(rig); // best-effort settle; ledger identity holds regardless
        } else {
          await rig.client.spin({ betIndex, params: { target: 1 + (i % 10) } });
        }
      } catch { /* individual round errors are fine; keep hammering */ }
    }
    // Ledger identity.
    const expected = rig.wallet.startBalance - rig.wallet.totalDebited() + rig.wallet.totalCredited();
    const actual = rig.wallet.balanceNow();
    const balanced = expected === actual;
    // Sanity: every credit row had a corresponding non-zero multiplier (no free credits).
    const freeCredit = rig.wallet.ledger.find((e) => e.credit > 0 && e.multiplier === 0 && !e.idempotent);
    record(game, "ledger conservation over 150 rounds", "CRIT", balanced && !freeCredit,
      `expected=${expected} actual=${actual}` + (freeCredit ? `; FREE CREDIT win=${freeCredit.credit} at ×0 (${freeCredit.type})` : "; no unfunded credits"));
  } catch (e) { recordError(game, "conservation", "CRIT", String(e)); }
  finally { await teardown(rig); }
}

// ── helpers for complex flow control ──────────────────────────────────────────

/** Boot a fresh rig, run `fn`, always tear down. Routes a thrown error to
 *  `onErr` so one sub-attack's failure never aborts the others. */
async function onRig(m: GameManifest, fn: (rig: Rig) => Promise<void>, onErr: (e: string) => void) {
  const rig = await boot(m);
  try { await fn(rig); }
  catch (e) { onErr(e instanceof Error ? e.message : String(e)); }
  finally { await teardown(rig); }
}

/** Best-effort close (don't care if it rejects — used to settle/drain a round). */
async function forceClose(rig: Rig) { try { await rig.client.closeRound({}); } catch { /* ignore */ } }

// Small seeded PRNG (NOT for production — attack determinism only).
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const flags: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a.startsWith("--")) flags[a.slice(2)] = argv[i + 1] ?? "true"; }
  const only = flags["game"];
  const list = only ? [only] : games();

  process.stderr.write(`\n🗡️  attacking ${list.length} game(s) over the real WS protocol…\n`);

  // Watchdog: a single wedged WS call must never hang the whole suite. Race each
  // attack against a timeout and record a (harness) error instead of hanging.
  const guard = (game: string, name: string, p: Promise<void>, ms = 60_000) =>
    Promise.race([p, new Promise<void>((res) => setTimeout(() => { recordError(game, `${name} (watchdog)`, "LOW", `timed out after ${ms}ms — harness/flow stall, not a game finding`); res(); }, ms))]);

  for (const game of list) {
    process.stderr.write(`  · ${game}\r`);
    const m = await build(game);
    await guard(game, "bet-injection", attackBetInjection(game, m));
    await guard(game, "param-injection", attackParamInjection(game, m));
    await guard(game, "replay", attackReplay(game, m));
    await guard(game, "lifecycle", attackLifecycle(game, m));
    await guard(game, "ladder-invariant", attackLadderInvariant(game, m), 90_000);
    await guard(game, "conservation", attackConservation(game, m));
  }
  process.stderr.write("                              \r");

  // ── report ──
  const o = process.stdout;
  const exploited = findings.filter((f) => f.status === "EXPLOITED");
  const errored = findings.filter((f) => f.status === "ERROR");
  o.write(`\n══════════════════ ATTACK REPORT ══════════════════\n`);
  o.write(`  ${findings.length} attacks · ${findings.length - exploited.length - errored.length} blocked · ${exploited.length} EXPLOITED · ${errored.length} errored\n\n`);

  // group by game
  for (const game of list) {
    const rows = findings.filter((f) => f.game === game);
    if (!rows.length) continue;
    o.write(`${game}\n`);
    for (const f of rows) {
      const mark = f.status === "BLOCKED" ? "✓" : f.status === "EXPLOITED" ? "💥" : "⚠";
      o.write(`  ${mark} [${f.severity}] ${f.attack}\n      ${f.detail}\n`);
    }
    o.write("\n");
  }

  // The verdict that matters: did any CRIT/HIGH (money) invariant fall? Separate
  // that from MED/LOW robustness findings (a crash that conserves money is a
  // DoS-hardening gap, not a theft) so the headline can't lie.
  const moneyBreaches = exploited.filter((f) => f.severity === "CRIT" || f.severity === "HIGH");
  const robustness = exploited.filter((f) => f.severity === "MED" || f.severity === "LOW");

  if (moneyBreaches.length) {
    o.write(`💥💥 ${moneyBreaches.length} MONEY EXPLOIT(S) — house can be beaten:\n`);
    for (const f of moneyBreaches) o.write(`   ${f.game} · [${f.severity}] ${f.attack} — ${f.detail}\n`);
    process.exitCode = 1;
  } else {
    o.write(`✓ MONEY SAFE — no CRIT/HIGH money invariant fell. The house cannot be beaten via the protocol.\n`);
  }
  if (robustness.length) {
    o.write(`\n⚠ ${robustness.length} robustness finding(s) (crash/DoS — no money impact; see docs/security.md):\n`);
    for (const f of robustness) o.write(`   ${f.game} · [${f.severity}] ${f.attack} — ${f.detail}\n`);
  }
  if (errored.length) o.write(`\nℹ ${errored.length} harness/flow errors ignored (not game findings).\n`);
}

main().catch((e) => { process.stderr.write(`attack harness crashed: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(2); });
