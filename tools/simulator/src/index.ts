#!/usr/bin/env bun
// open-rgs-examples · sim
//
//   bun run sim --game limbo                     # default report (1 strategy)
//   bun run sim --game limbo --spins 1e7         # tighter CI (slower — see below)
//   bun run sim --game mines --compare           # every strategy, side by side
//   bun run sim --game blackjack --strategy basic
//   bun run sim --game dice --compare            # sweeps the target (simple games)
//
// Default run uses @open-rgs/simulator. --strategy / --compare use the
// strategy engine in strategies.ts. See docs/math-testing.md.
//
// Perf note: wasmoon runs each Lua call in ~tens of microseconds, so ~1M
// spins ≈ tens of seconds and 1e7 is a multi-minute certification run. The
// default (100k, or 50k for --compare) is the quick interactive setting.

// Quiet the structured RGS logs that the math loader emits to stdout.
process.env["OPEN_RGS_LOG_LEVEL"] ??= "error";
process.env["LOG_LEVEL"] ??= "error";

import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate } from "@open-rgs/simulator";
import { mulberry32 } from "@open-rgs/simulator/rng";
import type { SimulationReport } from "@open-rgs/simulator";
import type { GameManifest, ComplexMath, SimpleMath } from "@open-rgs/contract";
import {
  runSimple, runComplex, computeStats,
  COMPLEX_STRATEGIES, SIMPLE_PRESETS, type Stats,
} from "./strategies.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const gamesDir = resolve(repoRoot, "games");

function listGames(): string[] {
  return readdirSync(gamesDir)
    .filter((d) => { try { return statSync(resolve(gamesDir, d, "src/manifest.ts")).isFile(); } catch { return false; } })
    .sort();
}

interface GameMeta { title?: string; emoji?: string; strategyDependent?: boolean }
function readMeta(game: string): GameMeta {
  try { return JSON.parse(readFileSync(resolve(gamesDir, game, "game.json"), "utf8")); }
  catch { return {}; }
}

interface Args {
  game: string | undefined;
  spins: number | undefined;
  seed: number;
  strategy: string | undefined;
  compare: boolean;
  params: Record<string, unknown> | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i]!;
    } else positional.push(a);
  }
  return {
    game: flags["game"] ?? positional[0],
    spins: flags["spins"] !== undefined ? Math.round(Number(flags["spins"])) : undefined,
    seed: Number(flags["seed"] ?? "1"),
    strategy: flags["strategy"],
    compare: flags["compare"] === "true",
    params: flags["params"] ? JSON.parse(flags["params"]) : undefined,
  };
}

async function buildManifest(game: string, seed: number): Promise<GameManifest> {
  const mod = await import(resolve(gamesDir, game, "src/manifest.ts"));
  const build = mod.buildManifest ?? mod.default;
  if (typeof build !== "function") throw new Error(`games/${game}/src/manifest.ts has no buildManifest export`);
  // Seeded PRNG for reproducible outcomes; watchdog off for speed; marks on for
  // the default report's deviation section.
  return build({ rng: mulberry32(seed), timeoutMs: 0, marks: true }) as Promise<GameManifest>;
}

const pct = (n: number) => (n * 100).toFixed(2) + "%";
const signPct = (n: number) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
const icon = (v: string) => (v === "pass" ? "✓" : v === "warn" ? "⚠" : "✗");

function statsRow(label: string, s: Stats, declared: number): string {
  return [
    label.padEnd(14),
    pct(s.rtp).padStart(8),
    signPct(s.rtp - declared).padStart(8),
    pct(s.hitRate).padStart(8),
    ("×" + s.max.toFixed(2)).padStart(11),
    `${icon(s.verdict)} ${s.verdict}`,
  ].join("  ");
}
const tableHead = ["strategy".padEnd(14), "RTP".padStart(8), "Δ".padStart(8), "hit".padStart(8), "max".padStart(11), "verdict"].join("  ");

function printDefault(game: string, meta: GameMeta, r: SimulationReport): void {
  const o = process.stdout;
  o.write(`\n${meta.emoji ?? "·"} ${meta.title ?? game} — declared RTP ${pct(r.rtp.declared)}\n`);
  o.write(`  measured ${pct(r.rtp.measured)}  ${icon(r.rtp.verdict)} ${r.rtp.verdict.toUpperCase()}   95% CI [${pct(r.rtp.ci95[0])}, ${pct(r.rtp.ci95[1])}]\n`);
  o.write(`  hit rate ${pct(r.hitRate)}   max ×${r.multiplier.max.toFixed(2)}   p99 ×${r.multiplier.p99.toFixed(2)}\n`);
  const types = Object.entries(r.outcomeTypes).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([t, n]) => `${t} ${pct(n / r.spins)}`).join(" · ");
  if (types) o.write(`  outcomes: ${types}\n`);
  if (r.deviations.length) {
    const bad = r.deviations.filter((d) => d.status !== "ok");
    o.write(`  targets: ${r.deviations.length - bad.length} ok${bad.length ? ` · ${bad.map((d) => d.key + " " + d.status).join(" · ")}` : ""}\n`);
  }
  o.write(`  ${r.spins.toLocaleString()} spins · ${r.elapsedMs}ms\n`);
  if (meta.strategyDependent) {
    o.write(`\n  ⚠ ${meta.title ?? game} is STRATEGY-DEPENDENT. This default run plays the\n` +
            `    simulator's generic picker (stand-always), which underperforms. Use\n` +
            `    --strategy basic, or --compare to see every strategy.\n`);
  }
  o.write("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const games = listGames();
  if (!args.game || !games.includes(args.game)) {
    process.stdout.write(
      (args.game ? `sim: unknown game '${args.game}'\n\n` : "Math-test an example game.\n\n") +
      `Usage: bun run sim --game <name> [--spins N] [--seed N] [--strategy S] [--compare] [--params '{...}']\n\n` +
      `Games: ${games.join(", ")}\n`,
    );
    process.exit(args.game ? 2 : 0);
  }

  const game = args.game;
  const meta = readMeta(game);
  const manifest = await buildManifest(game, args.seed);
  const mode = manifest.modes[manifest.defaultMode]!;
  const declared = manifest.declaredRtp;
  const kind = mode.math.kind;
  const o = process.stdout;

  // ── --compare ───────────────────────────────────────────────────────────
  if (args.compare) {
    const spins = args.spins ?? 50_000;
    const stratRng = mulberry32(args.seed ^ 0x9e3779b9);

    if (kind === "simple") {
      const presets = SIMPLE_PRESETS[game] ?? [{ label: "default", params: {} }];
      o.write(`\n${meta.emoji ?? "·"} ${meta.title ?? game} — RTP is independent of the player's choice\n`);
      o.write(`  (${spins.toLocaleString()} spins each, seed ${args.seed}, declared ${pct(declared)})\n\n  ${tableHead}\n`);
      for (const preset of presets) {
        const s = await runSimple(mode.math as SimpleMath, spins, declared, preset.params);
        o.write("  " + statsRow(preset.label, s, declared) + "\n");
      }
      o.write(`\n  → every choice lands on the same RTP: the house edge can't be out-played.\n\n`);
    } else {
      const set = COMPLEX_STRATEGIES[game] ?? {};
      o.write(`\n${meta.emoji ?? "·"} ${meta.title ?? game} — strategy comparison\n`);
      o.write(`  (${spins.toLocaleString()} spins each, seed ${args.seed}, declared ${pct(declared)})\n\n  ${tableHead}\n`);
      for (const [name, strat] of Object.entries(set)) {
        process.stderr.write(`  …running ${name}\r`);
        const s = await runComplex(mode.math as ComplexMath, strat, spins, declared, stratRng, args.params);
        o.write("  " + statsRow(name, s, declared) + "\n");
      }
      process.stderr.write("                         \r");
      if (meta.strategyDependent) {
        o.write(`\n  → only 'basic' reaches the declared RTP; every other strategy gives the\n` +
                `    house more. RTP here is a property of the strategy, not the math alone.\n\n`);
      } else {
        o.write(`\n  → every strategy lands on the same RTP: this is a constant-EV ladder, so\n` +
                `    cashing out early or late can't beat (or lose to) the house edge.\n\n`);
      }
    }
    return;
  }

  // ── --strategy <s> (complex only) ─────────────────────────────────────────
  if (args.strategy) {
    if (kind !== "complex") { process.stderr.write(`sim: --strategy only applies to complex games; ${game} is simple.\n`); process.exit(2); }
    const set = COMPLEX_STRATEGIES[game] ?? {};
    const strat = set[args.strategy];
    if (!strat) { process.stderr.write(`sim: unknown strategy '${args.strategy}' for ${game}. Options: ${Object.keys(set).join(", ")}\n`); process.exit(2); }
    const spins = args.spins ?? 100_000;
    const s = await runComplex(mode.math as ComplexMath, strat, spins, declared, mulberry32(args.seed ^ 0x9e3779b9), args.params);
    o.write(`\n${meta.emoji ?? "·"} ${meta.title ?? game} · strategy '${args.strategy}'\n\n  ${tableHead}\n  ${statsRow(args.strategy, s, declared)}\n\n`);
    o.write(`  95% CI [${pct(s.ci95[0])}, ${pct(s.ci95[1])}] · p50 ×${s.p50.toFixed(2)} · p90 ×${s.p90.toFixed(2)} · p99 ×${s.p99.toFixed(2)}\n\n`);
    return;
  }

  // ── default: @open-rgs/simulator report ───────────────────────────────────
  const spins = args.spins ?? 100_000;
  process.stderr.write(`  …simulating ${spins.toLocaleString()} spins\r`);
  const [report] = await simulate(manifest, { spinsPerMode: spins, seed: args.seed });
  process.stderr.write("                                   \r");
  if (report) printDefault(game, meta, report);
}

main().catch((e) => {
  process.stderr.write(`sim: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
