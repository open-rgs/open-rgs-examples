// limbo — manifest builder.
//
// `buildManifest()` loads the Lua math and composes a GameManifest. The server
// (src/index.ts) calls it with defaults; the simulator calls it with a seeded
// PRNG, the watchdog off, and marks on. Keeping the wiring in one builder is
// what lets `bun run dev`, `bun run play`, and `bun run sim` all share it.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { loadLuaMath } from "@open-rgs/core";
import { defineGame, type GameManifest } from "@open-rgs/contract";

const here = fileURLToPath(new URL(".", import.meta.url));

/** A certified CSPRNG for real play. Production open-rgs requires one —
 *  loadLuaMath fails closed without an injected rng under NODE_ENV=production. */
function cryptoRng(): number {
  const u = new Uint32Array(2);
  webcrypto.getRandomValues(u);
  return (u[0]! * 2 ** 21 + (u[1]! >>> 11)) / 2 ** 53;
}

export interface BuildOptions {
  /** Outcome RNG. Defaults to a CSPRNG; the simulator injects a seeded PRNG. */
  rng?: () => number;
  /** Math watchdog budget in ms. The simulator passes 0 to run flat out. */
  timeoutMs?: number;
  /** Collect host.mark.* annotations for the simulator's deviation report. */
  marks?: boolean;
}

export async function buildManifest(opts: BuildOptions = {}): Promise<GameManifest> {
  const math = await loadLuaMath(resolve(here, "../maths/limbo.lua"), {
    rng: opts.rng ?? cryptoRng,
    timeoutMs: opts.timeoutMs ?? 1000,
    marks: opts.marks ?? false,
  });

  return defineGame({
    id: "limbo",
    declaredRtp: 0.99,
    defaultMode: "default",
    maxWinMultiplier: 1_000_000,
    modes: {
      default: { math, stakeMultiplier: 1, label: "Limbo" },
    },
  });
}

export default buildManifest;
