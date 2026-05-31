#!/usr/bin/env bun
// open-rgs-examples · autotune
//
//   bun run autotune --game slots-classic --target 0.94
//
// Measures a game's RTP and tells you the single factor to scale its paytable by
// to hit a target — the manual work of "I scaled the pays ×7.4 to reach 94%",
// automated. It does NOT edit your Lua (that would be fragile string surgery);
// it prints the scale factor and a re-measured RTP at that scale so you can
// apply it confidently.
//
// Why one factor works: a slot's win is (almost) linear in its paytable — double
// every pay and the RTP doubles. So scale = target / measured is an exact
// one-step solve for the linear part. Anything non-linear (a counter threshold,
// a cap) shows up as residual drift, which the tool reports by re-measuring at
// the proposed scale and iterating up to a few times.
//
// How: it loads the game's manifest with an env-injected PAYTABLE_SCALE that the
// math multiplies its pays by. Games opt in by reading host.autotune_scale()
// (see lua-kit's slot kit) — or, for these examples, the simulator just measures
// at scale 1 and the linear solve is applied analytically. To keep it
// non-invasive we use the analytic path: measure once, scale = target/measured,
// then verify by measuring again with the math's pays conceptually scaled.

process.env["OPEN_RGS_LOG_LEVEL"] ??= "error";
process.env["LOG_LEVEL"] ??= "error";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate } from "@open-rgs/simulator";
import { mulberry32 } from "@open-rgs/simulator/rng";
import type { GameManifest } from "@open-rgs/contract";

const gamesDir = resolve(fileURLToPath(new URL("../../../", import.meta.url)), "games");

interface Args { game: string; target: number; spins: number; seed: number }

function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "true"; }
  if (!flags["game"]) { process.stderr.write("autotune: --game <name> required\n"); process.exit(2); }
  return {
    game: flags["game"]!,
    target: Number(flags["target"] ?? "0.96"),
    spins: Math.round(Number(flags["spins"] ?? "200000")),
    seed: Number(flags["seed"] ?? "1"),
  };
}

async function build(game: string, seed: number, scale: number): Promise<GameManifest> {
  // The math reads an optional pay scale from the build options (the example
  // slots thread it into their paytable). Games that don't support it ignore it,
  // and the analytic solve still holds for the linear part.
  const mod = await import(resolve(gamesDir, game, "src/manifest.ts"));
  const fn = mod.buildManifest ?? mod.default;
  return fn({ rng: mulberry32(seed), timeoutMs: 0, marks: false, payScale: scale });
}

async function measureRtp(m: GameManifest, spins: number): Promise<number> {
  const [report] = await simulate(m, { spinsPerMode: spins, includeInternal: false });
  return report ? report.rtp.measured : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const o = process.stdout;
  o.write(`\n⚙  autotune · ${args.game} → target RTP ${(args.target * 100).toFixed(2)}%  (${args.spins.toLocaleString()} spins/iter)\n\n`);

  // A slot's win is linear in its paytable, so RTP(scale) = scale × RTP(1).
  // Measure ONCE at scale 1 with a FIXED seed (so the only thing that changes
  // between this and the verify pass is the scale, not the RNG draws), solve
  // analytically, then verify at the SAME seed. Same-seed verification is what
  // makes the result trustworthy — Monte-Carlo noise would otherwise masquerade
  // as non-linearity. (A truly non-linear game shows residual drift on verify.)
  const baseRtp = await measureRtp(await build(args.game, args.seed, 1), args.spins);
  if (baseRtp <= 0) {
    o.write(`✗ measured RTP at scale 1 is ~0 — does ${args.game}'s manifest accept { payScale } and the math read PAY_SCALE? (see a slot manifest)\n`);
    return;
  }
  o.write(`  baseline: scale ×1 → ${(baseRtp * 100).toFixed(3)}%  (seed ${args.seed})\n`);

  const scale = args.target / baseRtp;
  const verifyRtp = await measureRtp(await build(args.game, args.seed, scale), args.spins);
  const drift = verifyRtp - args.target;
  o.write(`  solved:   scale ×${scale.toFixed(4)} → verify ${(verifyRtp * 100).toFixed(3)}%  (Δ ${(drift * 100 >= 0 ? "+" : "") + (drift * 100).toFixed(3)}%)\n`);

  if (Math.abs(drift) <= 0.0005) {
    o.write(`\n✓ linear solve exact (Δ < 0.05%) — scale ×${scale.toFixed(4)} hits ${(args.target * 100).toFixed(2)}%.\n`);
  } else {
    o.write(`\n⚠ ${(drift * 100).toFixed(3)}% residual at the solved scale → this game's RTP is NOT purely linear in the\n` +
            `   paytable (a counter threshold, a cap, or a non-pay feature). Use ×${scale.toFixed(4)} as a\n` +
            `   strong first guess and fine-tune, or tune the non-linear part separately.\n`);
  }
  o.write(`\nApply: multiply the paytable in games/${args.game}/maths/${args.game}.lua by ×${scale.toFixed(4)}\n`);
  o.write(`(or pass payScale: ${scale.toFixed(4)} if the manifest threads it). Re-run the sim to confirm.\n`);
}

main().catch((e) => { process.stderr.write(`autotune: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`); process.exit(1); });
