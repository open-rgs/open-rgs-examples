// Attack harness primitives.
//
// Each test boots a game's REAL server (createServer + binary transport) with a
// ledger-instrumented wallet, then drives it through the actual @open-rgs/client
// over WebSocket — exactly what a remote attacker has. No internal shortcuts:
// if an exploit works here, it works against a deployed server.
//
// The wallet records every money movement so tests can assert the one invariant
// that matters to an antifraud team: money is conserved, and the house only
// ever pays out a win the math actually produced.

import { createServer, binaryTransport, type ServerHandle } from "@open-rgs/core";
import type { GameManifest, PlatformAdapter, PlatformEvent, SessionInfo, SettleSimple, OpenComplex, UpdateComplex, CloseComplex, RoundReceipt } from "@open-rgs/contract";
import { RgsClient } from "@open-rgs/client";

// ── Ledger-instrumented wallet ────────────────────────────────────────────────
// A faithful wallet (idempotency, integer guards) that also logs every debit and
// credit with the round id, so a test can reconstruct exactly what moved.

export interface LedgerEntry {
  call: "settleSimple" | "openComplex" | "closeComplex";
  roundId: string;
  debit: number;   // minor units removed from balance
  credit: number;  // minor units added
  multiplier: number;
  type: string;
  idempotent: boolean; // true = this call was a replay, no money moved
}

function assertMinorUnits(n: number, field: string): void {
  if (!Number.isInteger(n) || n < 0) throw new Error(`InvalidAmount: ${field}=${n}`);
}

export class LedgerWallet implements PlatformAdapter {
  readonly ledger: LedgerEntry[] = [];
  readonly startBalance: number;
  private balance: number;
  private open?: { roundId: string; cost: number };
  private receipts = new Map<string, RoundReceipt>();
  private seq = 0;
  private connected = false;

  constructor(start = 1_000_000) { this.startBalance = start; this.balance = start; }

  async connect() { this.connected = true; }
  disconnect() { this.connected = false; }
  get isHealthy() { return this.connected; }
  get diagnostics() { return { balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) { /* not exercised */ }

  balanceNow() { return this.balance; }
  /** Net change the house experienced = credits − debits (player's profit). */
  playerProfit() { return this.balance - this.startBalance; }
  totalDebited() { return this.ledger.reduce((a, e) => a + e.debit, 0); }
  totalCredited() { return this.ledger.reduce((a, e) => a + e.credit, 0); }

  async openSession(sessionId: string): Promise<SessionInfo> {
    return {
      sessionId, currency: "FUN", currencyDecimals: 2, balance: this.balance,
      allowedBets: [20, 50, 100, 200, 500, 1000], defaultBetIndex: 2,
    };
  }

  private replay(key?: string) { return key !== undefined ? this.receipts.get(key) : undefined; }
  private remember(key: string | undefined, r: RoundReceipt) { if (key !== undefined) this.receipts.set(key, { ...r }); return r; }

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) { this.ledger.push({ call: "settleSimple", roundId: dup.roundId, debit: 0, credit: 0, multiplier: req.multiplier, type: req.type, idempotent: true }); return { ...dup }; }
    assertMinorUnits(req.bet, "bet"); assertMinorUnits(req.win, "win");
    const cost = req.bet * (req.priceMultiplier ?? 1);
    if (cost > this.balance) throw new Error("InsufficientFunds");
    this.balance = this.balance - cost + req.win;
    const roundId = `r-${++this.seq}`;
    this.ledger.push({ call: "settleSimple", roundId, debit: cost, credit: req.win, multiplier: req.multiplier, type: req.type, idempotent: false });
    return this.remember(req.idempotencyKey, { roundId, balance: this.balance });
  }

  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) { this.ledger.push({ call: "openComplex", roundId: dup.roundId, debit: 0, credit: 0, multiplier: 0, type: "open", idempotent: true }); return { ...dup }; }
    assertMinorUnits(req.bet, "bet");
    const cost = req.bet * (req.priceMultiplier ?? 1);
    if (cost > this.balance) throw new Error("InsufficientFunds");
    this.balance -= cost;
    const roundId = `r-${++this.seq}`;
    this.open = { roundId, cost };
    this.ledger.push({ call: "openComplex", roundId, debit: cost, credit: 0, multiplier: 0, type: "open", idempotent: false });
    return this.remember(req.idempotencyKey, { roundId, balance: this.balance });
  }

  async updateComplex(_req: UpdateComplex) { /* audit-only */ }

  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) { this.ledger.push({ call: "closeComplex", roundId: dup.roundId, debit: 0, credit: 0, multiplier: req.multiplier, type: req.type, idempotent: true }); return { ...dup }; }
    assertMinorUnits(req.win, "win");
    if (!this.open || this.open.roundId !== req.roundId) throw new Error(`InvalidRoundOperation: no open round ${req.roundId}`);
    this.balance += req.win;
    this.open = undefined;
    this.ledger.push({ call: "closeComplex", roundId: req.roundId, debit: 0, credit: req.win, multiplier: req.multiplier, type: req.type, idempotent: false });
    return this.remember(req.idempotencyKey, { roundId: req.roundId, balance: this.balance });
  }
}

// ── server + client lifecycle ─────────────────────────────────────────────────

// Start high and never repeat within a run. Each process gets a distinct base
// so back-to-back `bun run attack` invocations don't fight over sockets in
// TIME_WAIT. (Deterministic per process start — no Math.random needed.)
let portCounter = 9300 + (process.pid % 4000);
export function nextPort() { return portCounter++; }

export interface Rig { handle: ServerHandle; client: RgsClient; wallet: LedgerWallet; port: number; }

export async function boot(manifest: GameManifest, start = 1_000_000): Promise<Rig> {
  // Bun.serve throws synchronously on EADDRINUSE, so we can retry onto a fresh
  // port. This makes boot collision-proof even under rapid boot/teardown churn
  // (the source of the earlier phantom "Close current round first" cascades:
  // a new rig was landing on a port a not-yet-freed server still held).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    const port = nextPort();
    const wallet = new LedgerWallet(start);
    try {
      const handle = await createServer({ manifest, platform: wallet, transport: binaryTransport({ port }), version: "attack" });
      const client = new RgsClient(`ws://localhost:${port}/wss`);
      await client.connect();
      return { handle, client, wallet, port };
    } catch (e) { lastErr = e; /* port busy or connect raced — try the next port */ }
  }
  throw new Error(`boot failed after 12 port attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export async function teardown(rig: Rig) {
  try { rig.client.disconnect(); } catch { /* ignore */ }
  // Await full server shutdown so the port is released before the suite moves
  // on — otherwise a later rig can collide with this one's listener.
  try { await rig.handle.stop({ drainMs: 0 }); } catch { /* ignore */ }
}

// ── assertion + reporting ─────────────────────────────────────────────────────

export interface Finding {
  game: string;
  attack: string;
  severity: "CRIT" | "HIGH" | "MED" | "LOW";
  status: "BLOCKED" | "EXPLOITED" | "ERROR";
  detail: string;
}

export const findings: Finding[] = [];

/** Record a result. `held` = the defense held (attack blocked). */
export function record(game: string, attack: string, severity: Finding["severity"], held: boolean, detail: string) {
  findings.push({ game, attack, severity, status: held ? "BLOCKED" : "EXPLOITED", detail });
}
export function recordError(game: string, attack: string, severity: Finding["severity"], detail: string) {
  findings.push({ game, attack, severity, status: "ERROR", detail });
}

/** Run a server-rejected expectation: the call SHOULD throw an RGS error. Returns
 *  true if it correctly threw (defense held). */
export async function expectReject(fn: () => Promise<unknown>): Promise<{ rejected: boolean; message: string }> {
  try { await fn(); return { rejected: false, message: "call succeeded (no error)" }; }
  catch (e) { return { rejected: true, message: e instanceof Error ? e.message : String(e) }; }
}
