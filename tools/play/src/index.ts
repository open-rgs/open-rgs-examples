#!/usr/bin/env bun
// open-rgs-examples · play
//
// Boots one game in-process and drives a single real round through the actual
// WebSocket client, so you can watch the whole stack work end to end:
//   client → binary-msgpack transport → orchestrator → Lua math → wallet.
// The wallet logs every call to stderr; this harness prints the round
// transcript to stdout.
//
//   bun run play --game limbo
//   bun run play --game limbo --params '{"target":5}'
//   bun run play --game mines --steps 4 --params '{"mines":3}'
//   bun run play                       # lists the available games

import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, binaryTransport } from "@open-rgs/core";
import { LoggingMockPlatform } from "@open-rgs-examples/mock-platform";
import { RgsClient } from "@open-rgs/client";
import type { GameManifest, PlayerAction, AwaitingHint } from "@open-rgs/contract";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const gamesDir = resolve(repoRoot, "games");

function listGames(): string[] {
  return readdirSync(gamesDir)
    .filter((d) => {
      try { return statSync(resolve(gamesDir, d, "src/manifest.ts")).isFile(); }
      catch { return false; }
    })
    .sort();
}

interface Args {
  game: string | undefined;
  port: number;
  steps: number;
  betIndex: number | undefined;
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
      else flags[a.slice(2)] = argv[++i] ?? "true";
    } else positional.push(a);
  }
  const params: Record<string, unknown> = flags["params"] ? JSON.parse(flags["params"]) : {};
  // Convenience flags folded into params.
  for (const k of ["target", "mines", "difficulty", "rows", "risk", "chance"] as const) {
    if (flags[k] !== undefined) {
      const v = flags[k]!;
      params[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
  }
  return {
    game: flags["game"] ?? positional[0],
    port: Number(flags["port"] ?? "8123"),
    steps: Number(flags["steps"] ?? "3"),
    betIndex: flags["bet"] !== undefined ? Number(flags["bet"]) : undefined,
    params: Object.keys(params).length ? params : undefined,
  };
}

async function loadBuild(game: string): Promise<(o?: unknown) => Promise<GameManifest>> {
  const mod = await import(resolve(gamesDir, game, "src/manifest.ts"));
  const build = mod.buildManifest ?? mod.default;
  if (typeof build !== "function") throw new Error(`games/${game}/src/manifest.ts has no buildManifest export`);
  return build as (o?: unknown) => Promise<GameManifest>;
}

function pickAction(awaiting: AwaitingHint): PlayerAction {
  const opts = awaiting.options;
  if (opts && opts.length > 0) return { type: awaiting.type, value: opts[0] };
  return { type: awaiting.type };
}

const j = (v: unknown) => JSON.stringify(v);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const games = listGames();
  if (!args.game || !games.includes(args.game)) {
    process.stdout.write(
      (args.game ? `play: unknown game '${args.game}'\n\n` : "Drive one round of an example game.\n\n") +
      `Usage: bun run play --game <name> [--params '{...}'] [--steps N] [--bet I] [--port P]\n\n` +
      `Games: ${games.join(", ")}\n`,
    );
    process.exit(args.game ? 2 : 0);
  }

  const manifest = await (await loadBuild(args.game))();
  const mode = manifest.modes[manifest.defaultMode];
  if (!mode) throw new Error(`manifest has no default mode '${manifest.defaultMode}'`);
  const kind = mode.math.kind;

  const platform = new LoggingMockPlatform({ startingBalance: 100_000 });
  const handle = await createServer({
    manifest,
    platform,
    transport: binaryTransport({ port: args.port }),
    version: "0.0.0",
  });

  const client = new RgsClient(`ws://localhost:${args.port}/wss`);
  await client.connect();

  try {
    const init = await client.init("play-demo");
    const money = (minor: number) =>
      `${(minor / 10 ** init.currencyDecimals).toFixed(init.currencyDecimals)}${init.currency ? " " + init.currency : ""}`;

    process.stdout.write(`\n▶ ${manifest.id}  (${kind})   RTP ${(manifest.declaredRtp * 100).toFixed(2)}%\n`);
    process.stdout.write(`  balance ${money(init.balance)} · bets ${j(init.allowedBets)} · default #${init.defaultBetIndex}\n`);
    if (args.params) process.stdout.write(`  params ${j(args.params)}\n`);
    process.stdout.write("\n");

    if (kind === "simple") {
      const r = await client.spin({
        ...(args.betIndex !== undefined ? { betIndex: args.betIndex } : {}),
        ...(args.params ? { params: args.params } : {}),
      });
      process.stdout.write(`  spin → ${r.type}  ×${r.multiplier}  win ${money(r.win)}\n`);
      for (const op of r.ops) process.stdout.write(`    op ${j(op)}\n`);
      process.stdout.write(`  balance ${money(r.balance)}\n`);
    } else {
      const open = await client.openRound({
        ...(args.betIndex !== undefined ? { betIndex: args.betIndex } : {}),
        ...(args.params ? { params: args.params } : {}),
      });
      process.stdout.write(`  open → bet ${money(open.bet)}  round ${open.roundId}\n`);
      for (const op of open.ops) process.stdout.write(`    op ${j(op)}\n`);

      let awaiting = open.awaiting;
      let steps = 0;
      while (awaiting && steps < args.steps) {
        const action = pickAction(awaiting);
        process.stdout.write(`  step → ${j(action)}${awaiting.prompt ? `   (${awaiting.prompt})` : ""}\n`);
        const s = await client.stepRound({ action });
        for (const op of s.ops) process.stdout.write(`    op ${j(op)}\n`);
        awaiting = s.awaiting;
        steps++;
      }
      if (awaiting) process.stdout.write(`  (cashing out after ${steps} step${steps === 1 ? "" : "s"})\n`);

      const close = await client.closeRound({});
      process.stdout.write(`  close → ${close.type}  ×${close.multiplier}  win ${money(close.win)}\n`);
      for (const op of close.ops) process.stdout.write(`    op ${j(op)}\n`);
      process.stdout.write(`  balance ${money(close.balance)}\n`);
    }
    process.stdout.write("\n");
  } finally {
    client.disconnect();
    await handle.stop({ drainMs: 0 });
  }
}

main().catch((e) => {
  process.stderr.write(`play: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
