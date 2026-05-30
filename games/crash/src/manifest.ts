// crash — manifest builder. Complex round; json prelude + autoclose.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { loadLuaMath } from "@open-rgs/core";
import { defineGame, type GameManifest } from "@open-rgs/contract";
import { exampleExtensions } from "@open-rgs-examples/lua-kit";

const here = fileURLToPath(new URL(".", import.meta.url));

function cryptoRng(): number {
  const u = new Uint32Array(2);
  webcrypto.getRandomValues(u);
  return (u[0]! * 2 ** 21 + (u[1]! >>> 11)) / 2 ** 53;
}

export interface BuildOptions {
  rng?: () => number;
  timeoutMs?: number;
  marks?: boolean;
}

export async function buildManifest(opts: BuildOptions = {}): Promise<GameManifest> {
  const math = await loadLuaMath(resolve(here, "../maths/crash.lua"), {
    rng: opts.rng ?? cryptoRng,
    timeoutMs: opts.timeoutMs ?? 1000,
    marks: opts.marks ?? false,
    extensions: exampleExtensions,
  });

  return defineGame({
    id: "crash",
    declaredRtp: 0.99,
    defaultMode: "default",
    maxWinMultiplier: 1_000_000,
    autoclose: { idleMs: 300_000, policy: "settle-at-current" },
    modes: {
      default: { math, stakeMultiplier: 1, label: "Crash" },
    },
  });
}

export default buildManifest;
