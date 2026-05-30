// @open-rgs-examples/mock-platform
//
// A PlatformAdapter you can read in one sitting. It does three things:
//
//   1. Holds a balance per session, in the currency's minimal unit (integer).
//   2. Moves money the way the contract demands — debit on open/settle,
//      credit on settle/close — with the safety posture a *real* wallet must
//      have: idempotency dedupe and integer-only amounts.
//   3. Logs every call, so when you run a game you can watch the wallet
//      protocol scroll past: openSession → openComplex → closeComplex, etc.
//
// open-rgs ships its own `@open-rgs/platform-mock` (the canonical dev wallet).
// This one is deliberately chattier and a touch simpler — it exists to *teach*
// the PlatformAdapter surface, not to be depended on. When you write a real
// adapter, this is the shape you're filling in; see `@open-rgs/adapter-kit`
// for the helpers (RPC clients, currency conversion, error mapping) you'll
// reach for against a real upstream wallet.
//
// What a real wallet MUST copy from here: the idempotency dedupe (a repeated
// idempotencyKey returns the ORIGINAL receipt and moves money at most once)
// and the integer-minor-unit guard. Everything else is yours to design.

import type {
  PlatformAdapter,
  PlatformEvent,
  SessionInfo,
  SettleSimple,
  OpenComplex,
  UpdateComplex,
  CloseComplex,
  RoundReceipt,
} from "@open-rgs/contract";

export interface LoggingMockPlatformOptions {
  /** Starting balance for a new session, in minor units. 100_000 = 1000.00
   *  when currencyDecimals = 2. */
  startingBalance?: number;
  /** Currency code. "" means a demo session (no real wallet). Default "FUN". */
  currency?: string;
  /** Fractional digits of the currency. EUR/USD = 2, JPY = 0, BTC = 8. */
  currencyDecimals?: number;
  /** Bet ladder in minor units. Default 0.20 .. 10.00. */
  allowedBets?: number[];
  defaultBetIndex?: number;
  /** Per-call logging. `true` (default) writes a line to stderr; pass your own
   *  sink to capture it, or `false` to stay quiet. */
  log?: boolean | ((line: string) => void);
}

interface SessionState {
  balance: number;
  openRound?: { roundId: string; cost: number };
}

/** Reject anything that isn't a non-negative integer minor unit — the
 *  contract's hard rule. A fractional or negative amount (an un-rounded win,
 *  a negative settle) must never reach a wallet; it corrupts the ledger. */
function assertMinorUnits(n: number, field: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`InvalidAmount: ${field} must be a non-negative integer minor unit, got ${n}`);
  }
}

export class LoggingMockPlatform implements PlatformAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly handlers: ((e: PlatformEvent) => void)[] = [];
  /** idempotencyKey → the receipt we produced the first time. A repeat returns
   *  this and moves no money. */
  private readonly receipts = new Map<string, RoundReceipt>();
  private roundSeq = 0;
  private settled = 0;
  private connected = false;

  private readonly startingBalance: number;
  private readonly currency: string;
  private readonly currencyDecimals: number;
  private readonly allowedBets: number[];
  private readonly defaultBetIndex: number;
  private readonly sink: ((line: string) => void) | null;

  constructor(opts: LoggingMockPlatformOptions = {}) {
    this.startingBalance = opts.startingBalance ?? 100_000;
    this.currency = opts.currency ?? "FUN";
    this.currencyDecimals = opts.currencyDecimals ?? 2;
    this.allowedBets = opts.allowedBets ?? [20, 50, 100, 200, 500, 1000];
    this.defaultBetIndex = opts.defaultBetIndex ?? 2;
    this.sink =
      opts.log === false ? null
      : typeof opts.log === "function" ? opts.log
      : (line: string) => process.stderr.write(line + "\n");
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.connected = true;
    this.log("connect", "wallet online");
  }
  disconnect(): void {
    this.connected = false;
    this.log("disconnect", "wallet offline");
  }
  get isHealthy(): boolean { return this.connected; }
  get diagnostics(): Record<string, unknown> {
    return {
      connected: this.connected,
      sessions: this.sessions.size,
      rounds_settled: this.settled,
      idempotency_keys_seen: this.receipts.size,
    };
  }

  onEvent(handler: (e: PlatformEvent) => void): void { this.handlers.push(handler); }
  private emit(e: PlatformEvent): void { for (const h of this.handlers) h(e); }

  // ─── session ────────────────────────────────────────────────────────────

  async openSession(sessionId: string, _connectionId: string): Promise<SessionInfo> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { balance: this.startingBalance };
      this.sessions.set(sessionId, s);
    }
    this.log("openSession", `sid=${sessionId}`, s.balance);
    return {
      sessionId,
      currency: this.currency,
      currencyDecimals: this.currencyDecimals,
      balance: s.balance,
      allowedBets: this.allowedBets,
      defaultBetIndex: this.defaultBetIndex,
    };
  }

  // ─── simple round (bet + win in one call) ─────────────────────────────────

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) { this.log("settleSimple", "↩ idempotent replay (no money moved)", dup.balance); return dup; }

    const s = this.must(req.sessionId);
    assertMinorUnits(req.bet, "bet");
    assertMinorUnits(req.win, "win");

    // Debit = bet × priceMultiplier. The orchestrator keeps `bet` at the base
    // wager and folds the mode's stakeMultiplier into priceMultiplier, so the
    // real cost rides on the wire — recompute it here exactly as a real wallet
    // would. (See @open-rgs/platform-mock for the same logic.)
    const cost = req.bet * (req.priceMultiplier ?? 1);
    if (cost > s.balance) throw new Error("InsufficientFunds");
    s.balance = s.balance - cost + req.win;
    this.settled++;

    const roundId = this.nextRoundId();
    this.log("settleSimple", `bet=${this.fmt(cost)} win=${this.fmt(req.win)} ×${req.multiplier} ${req.type}`, s.balance);
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "spin" });
    return this.remember(req.idempotencyKey, { roundId, balance: s.balance });
  }

  // ─── complex round (debit on open, credit on close) ───────────────────────

  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) { this.log("openComplex", "↩ idempotent replay (no money moved)", dup.balance); return dup; }

    const s = this.must(req.sessionId);
    assertMinorUnits(req.bet, "bet");
    const cost = req.bet * (req.priceMultiplier ?? 1);
    if (cost > s.balance) throw new Error("InsufficientFunds");
    s.balance -= cost;

    const roundId = this.nextRoundId();
    s.openRound = { roundId, cost };
    this.log("openComplex", `bet=${this.fmt(cost)} → round ${roundId} (debit, win pending)`, s.balance);
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "open" });
    return this.remember(req.idempotencyKey, { roundId, balance: s.balance });
  }

  async updateComplex(req: UpdateComplex): Promise<void> {
    // Audit-only checkpoint — no money moves. A regulator-facing wallet would
    // append `req.state` to a per-round action log here. We just note it.
    this.log("updateComplex", `round ${req.roundId} (audit checkpoint, no money)`);
  }

  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) { this.log("closeComplex", "↩ idempotent replay (no money moved)", dup.balance); return dup; }

    const s = this.must(req.sessionId);
    assertMinorUnits(req.win, "win");
    if (!s.openRound || s.openRound.roundId !== req.roundId) {
      throw new Error(`InvalidRoundOperation: no open round ${req.roundId}`);
    }
    s.balance += req.win;
    s.openRound = undefined;
    this.settled++;

    const tag = req.reason ? `${req.type} (autoclose: ${req.reason})` : req.type;
    this.log("closeComplex", `round ${req.roundId} win=${this.fmt(req.win)} ×${req.multiplier} ${tag}`, s.balance);
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "close" });
    return this.remember(req.idempotencyKey, { roundId: req.roundId, balance: s.balance });
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** Read the current balance of a session (test/inspection helper). */
  balanceOf(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.balance;
  }

  private replay(key: string | undefined): RoundReceipt | undefined {
    if (key === undefined) return undefined;
    const prev = this.receipts.get(key);
    return prev ? { ...prev } : undefined;
  }
  private remember(key: string | undefined, receipt: RoundReceipt): RoundReceipt {
    if (key !== undefined) this.receipts.set(key, { ...receipt });
    return receipt;
  }

  private must(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) { s = { balance: this.startingBalance }; this.sessions.set(sessionId, s); }
    return s;
  }

  private nextRoundId(): string { return `r-${++this.roundSeq}`; }

  /** Format minor units as a human amount, e.g. 100098 → "1,000.98 FUN". */
  private fmt(minor: number): string {
    const d = this.currencyDecimals;
    const major = (minor / 10 ** d).toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
    return this.currency ? `${major} ${this.currency}` : major;
  }

  private log(call: string, detail: string, balance?: number): void {
    if (!this.sink) return;
    const head = `[wallet] ${call.padEnd(14)}`;
    const tail = balance === undefined ? "" : ` → balance ${this.fmt(balance)}`;
    this.sink(`${head}${detail}${tail}`);
  }
}
