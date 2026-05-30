// slots-meta — manifest builder. SimpleMath that threads progress through carry.
// Pairs with @open-rgs-examples/meta-platform, which owns the stake-lock and
// rollback safety the math is structurally unable to provide.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { loadLuaMath } from "@open-rgs/core";
import { defineGame, type GameManifest } from "@open-rgs/contract";
import { exampleExtensions } from "@open-rgs-examples/lua-kit"; // json + params

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
  const math = await loadLuaMath(resolve(here, "../maths/slots-meta.lua"), {
    rng: opts.rng ?? cryptoRng,
    timeoutMs: opts.timeoutMs ?? 1000,
    marks: opts.marks ?? false,
    extensions: exampleExtensions,
  });

  return defineGame({
    id: "slots-meta",
    declaredRtp: 0.94,
    defaultMode: "default",
    maxWinMultiplier: 5000,
    modes: {
      default: { math, stakeMultiplier: 1, label: "Meta Slots — Scatter Collector" },
    },
  });
}

export default buildManifest;
