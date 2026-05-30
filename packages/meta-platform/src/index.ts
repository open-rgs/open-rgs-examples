// @open-rgs-examples/meta-platform
//
// A PlatformAdapter for games with META-PROGRESSION — persistent state that
// builds up across many rounds and pays out later (slots-meta: 10 scatters →
// bonus). That deferred payout is the dangerous shape, and this adapter is where
// the danger is contained, because the MATH CANNOT DO IT:
//
//   • The math is currency-blind — it never sees the bet (SpinContext is
//     {mode, params}). So it cannot tell that progress was earned cheap and is
//     being cashed expensive. Only a bet-aware component can. That's the adapter.
//   • ctx.params is client-controlled — the math can't trust a "my bet is X"
//     hint. The adapter sees the REAL bet on every settle. That's the adapter.
//
// Two invariants close the two exploits the brief calls out:
//
//   1. STAKE-LOCK (kills bet-switching). The instant progress goes from 0 to
//      positive, we pin `lockedBet` to the bet that started it. Every later
//      settle that still carries progress MUST use the same bet, or we reject it
//      (StakeLockViolation). You accumulate and cash at one bet — no "build at
//      0.20, trigger at 10.00". The lock clears when progress returns to 0
//      (bonus consumed), so the next meta can start at any bet.
//
//   2. ATOMIC (balance, carry) + SNAPSHOT ROLLBACK (kills rollback-farming).
//      Money and progress are written in the SAME settle record. Before applying
//      a settle we snapshot (balance, carry, lock) keyed by roundId; rollback()
//      restores all three together. So you can never reverse the money while
//      keeping the progress, or gain progress and roll back to dodge the debit
//      — the pair moves as one.
//
// Carry format (this adapter's contract with slots-meta's Lua):
//     { "progress": <int 0..GOAL>, "lockedBet": <minor units|null> }
// The adapter only READS progress to manage the lock; the math owns the value.

import type {
  PlatformAdapter, PlatformEvent, SessionInfo,
  SettleSimple, OpenComplex, UpdateComplex, CloseComplex, RoundReceipt,
} from "@open-rgs/contract";

export interface MetaPlatformOptions {
  startingBalance?: number;
  currency?: string;
  currencyDecimals?: number;
  allowedBets?: number[];
  defaultBetIndex?: number;
  log?: boolean | ((line: string) => void);
}

interface Carry { progress: number; lockedBet: number | null }

interface SessionState {
  balance: number;
  /** Opaque carry string we hand back on openSession. Source of truth for
   *  cross-round progress + the stake-lock. */
  carry: string | undefined;
  /** Per-round snapshot of (balance, carry) taken BEFORE the settle was
   *  applied, so a rollback restores the exact prior state of both. */
  snapshots: Map<string, { balance: number; carry: string | undefined }>;
}

function assertMinorUnits(n: number, field: string): void {
  if (!Number.isInteger(n) || n < 0) throw new Error(`InvalidAmount: ${field}=${n} must be a non-negative integer`);
}

/** Parse a carry string into {progress, lockedBet}, tolerating absence/garbage
 *  (a fresh session has no carry; we treat anything unparseable as zero state). */
function parseCarry(carry: string | undefined): Carry {
  if (!carry) return { progress: 0, lockedBet: null };
  try {
    const o = JSON.parse(carry) as Record<string, unknown>;
    const progress = Number.isFinite(o["progress"]) ? Math.max(0, Math.floor(o["progress"] as number)) : 0;
    const lb = o["lockedBet"];
    const lockedBet = typeof lb === "number" && Number.isInteger(lb) && lb > 0 ? lb : null;
    return { progress, lockedBet };
  } catch { return { progress: 0, lockedBet: null }; }
}

export class StakeLockViolation extends Error {
  constructor(public readonly lockedBet: number, public readonly attemptedBet: number) {
    super(`StakeLockViolation: meta-progress is locked to bet ${lockedBet}; this round bet ${attemptedBet}. ` +
          `Finish or clear the meta before changing your stake.`);
    this.name = "StakeLockViolation";
  }
}

export class MetaPlatform implements PlatformAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly handlers: ((e: PlatformEvent) => void)[] = [];
  private readonly receipts = new Map<string, RoundReceipt>();
  private roundSeq = 0;
  private connected = false;

  private readonly startingBalance: number;
  private readonly currency: string;
  private readonly currencyDecimals: number;
  private readonly allowedBets: number[];
  private readonly defaultBetIndex: number;
  private readonly sink: ((line: string) => void) | null;

  constructor(opts: MetaPlatformOptions = {}) {
    this.startingBalance = opts.startingBalance ?? 100_000;
    this.currency = opts.currency ?? "FUN";
    this.currencyDecimals = opts.currencyDecimals ?? 2;
    this.allowedBets = opts.allowedBets ?? [20, 50, 100, 200, 500, 1000];
    this.defaultBetIndex = opts.defaultBetIndex ?? 2;
    this.sink = opts.log === false ? null
      : typeof opts.log === "function" ? opts.log
      : (line) => process.stderr.write(line + "\n");
  }

  async connect() { this.connected = true; this.log("connect", "wallet online"); }
  disconnect() { this.connected = false; }
  get isHealthy() { return this.connected; }
  get diagnostics() { return { connected: this.connected, sessions: this.sessions.size }; }
  onEvent(h: (e: PlatformEvent) => void) { this.handlers.push(h); }
  private emit(e: PlatformEvent) { for (const h of this.handlers) h(e); }

  async openSession(sessionId: string): Promise<SessionInfo> {
    const s = this.must(sessionId);
    const c = parseCarry(s.carry);
    this.log("openSession", `sid=${sessionId} progress=${c.progress} lockedBet=${c.lockedBet ?? "-"}`, s.balance);
    return {
      sessionId, currency: this.currency, currencyDecimals: this.currencyDecimals,
      balance: s.balance, allowedBets: this.allowedBets, defaultBetIndex: this.defaultBetIndex,
      // Hand the stored carry back so RGS seeds the next round's math with it.
      ...(s.carry !== undefined ? { carry: s.carry } : {}),
    };
  }

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) { this.log("settleSimple", "↩ idempotent replay (no money, no progress)", dup.balance); return dup; }

    const s = this.must(req.sessionId);
    assertMinorUnits(req.bet, "bet");
    assertMinorUnits(req.win, "win");

    const before = parseCarry(s.carry);       // progress/lock as it stood entering this round
    const after = parseCarry(req.roundState); // math's new carry (it owns progress)
    const cost = req.bet * (req.priceMultiplier ?? 1);

    // ── INVARIANT 1: STAKE-LOCK ───────────────────────────────────────────
    // If a meta is already in progress, this round MUST be at the locked bet.
    // We check BEFORE moving any money, so a rejected bet-switch costs nothing
    // and changes nothing.
    if (before.progress > 0 && before.lockedBet !== null && cost !== before.lockedBet) {
      this.log("settleSimple", `✋ REJECT bet-switch: locked ${before.lockedBet}, got ${cost} (progress ${before.progress})`, s.balance);
      throw new StakeLockViolation(before.lockedBet, cost);
    }

    if (cost > s.balance) throw new Error("InsufficientFunds");

    // Mint the round id, then snapshot (balance, carry) BEFORE applying — so a
    // later rollback(roundId) restores the exact pre-round state of BOTH.
    const roundId = this.nextRoundId();
    s.snapshots.set(roundId, { balance: s.balance, carry: s.carry });

    // Apply money.
    s.balance = s.balance - cost + req.win;

    // Apply carry, RE-DERIVING the lock from the math's new progress so the
    // adapter — not the client, not the math — owns the lock lifecycle:
    //   • progress just went 0 → >0 : pin the lock to THIS round's bet.
    //   • progress stays   >0 → >0 : keep the existing lock (bet already matched).
    //   • progress back to        0 : clear the lock (meta consumed → free to re-bet).
    let lockedBet: number | null;
    if (after.progress <= 0) lockedBet = null;
    else if (before.progress <= 0) lockedBet = cost;               // meta just started
    else lockedBet = before.lockedBet;                              // meta continuing
    const newCarry: Carry = { progress: after.progress, lockedBet };
    s.carry = JSON.stringify(newCarry);

    const transition = after.progress !== before.progress ? ` progress ${before.progress}→${after.progress}` : "";
    const lockMsg = lockedBet !== null ? ` [locked@${lockedBet}]` : (before.lockedBet !== null ? " [lock cleared]" : "");
    this.log("settleSimple", `bet=${cost} win=${req.win} ${req.type}${transition}${lockMsg}`, s.balance);
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "spin" });
    return this.remember(req.idempotencyKey, { roundId, balance: s.balance });
  }

  // Complex rounds aren't used by slots-meta, but the interface requires them.
  async openComplex(_req: OpenComplex): Promise<RoundReceipt> { throw new Error("meta-platform: complex rounds not supported"); }
  async updateComplex(_req: UpdateComplex): Promise<void> { /* n/a */ }
  async closeComplex(_req: CloseComplex): Promise<RoundReceipt> { throw new Error("meta-platform: complex rounds not supported"); }

  // ── rollback support ──────────────────────────────────────────────────────

  /** Reverse a settled round: restore (balance, carry, lock) to the snapshot
   *  taken before it was applied. This is the operation a real wallet performs
   *  on a chargeback / reconciliation reversal — and the reason money and
   *  progress MUST be one record: they roll back together or the player farms
   *  the gap. Returns true if a snapshot existed. */
  rollback(sessionId: string, roundId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const snap = s.snapshots.get(roundId);
    if (!snap) return false;
    s.balance = snap.balance;
    s.carry = snap.carry;
    s.snapshots.delete(roundId);
    const c = parseCarry(s.carry);
    this.log("rollback", `round ${roundId} reverted → progress=${c.progress} lockedBet=${c.lockedBet ?? "-"}`, s.balance);
    this.emit({ type: "balanceChanged", sessionId, balance: s.balance, reason: "rollback" });
    return true;
  }

  // ── inspection helpers (tests/attacks) ──────────────────────────────────────
  balanceOf(sessionId: string) { return this.sessions.get(sessionId)?.balance; }
  progressOf(sessionId: string) { return parseCarry(this.sessions.get(sessionId)?.carry).progress; }
  lockedBetOf(sessionId: string) { return parseCarry(this.sessions.get(sessionId)?.carry).lockedBet; }

  // ── internals ───────────────────────────────────────────────────────────────
  private replay(key?: string) { return key !== undefined ? this.receipts.get(key) : undefined; }
  private remember(key: string | undefined, r: RoundReceipt) { if (key !== undefined) this.receipts.set(key, { ...r }); return r; }
  private must(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) { s = { balance: this.startingBalance, carry: undefined, snapshots: new Map() }; this.sessions.set(sessionId, s); }
    return s;
  }
  private nextRoundId() { return `r-${++this.roundSeq}`; }

  private log(call: string, detail: string, balance?: number) {
    if (!this.sink) return;
    const tail = balance === undefined ? "" : ` → balance ${balance}`;
    this.sink(`[meta-wallet] ${call.padEnd(13)} ${detail}${tail}`);
  }
}
