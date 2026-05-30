// dice — manifest builder. Simple round; shared by dev / play / sim.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { loadLuaMath } from "@open-rgs/core";
import { defineGame, type GameManifest } from "@open-rgs/contract";

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
  const math = await loadLuaMath(resolve(here, "../maths/dice.lua"), {
    rng: opts.rng ?? cryptoRng,
    timeoutMs: opts.timeoutMs ?? 1000,
    marks: opts.marks ?? false,
  });

  return defineGame({
    id: "dice",
    declaredRtp: 0.99,
    defaultMode: "default",
    maxWinMultiplier: 10_000,
    modes: {
      default: { math, stakeMultiplier: 1, label: "Dice" },
    },
  });
}

export default buildManifest;
