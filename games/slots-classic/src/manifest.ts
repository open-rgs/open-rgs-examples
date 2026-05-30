// slots-classic — manifest builder. SimpleMath; free spins resolve atomically
// inside the trigger spin, so the safe param reader is all it needs.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { loadLuaMath } from "@open-rgs/core";
import { defineGame, type GameManifest } from "@open-rgs/contract";
import { paramsOnly } from "@open-rgs-examples/lua-kit";

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
  const math = await loadLuaMath(resolve(here, "../maths/slots-classic.lua"), {
    rng: opts.rng ?? cryptoRng,
    timeoutMs: opts.timeoutMs ?? 1000,
    marks: opts.marks ?? false,
    extensions: paramsOnly,
  });

  return defineGame({
    id: "slots-classic",
    declaredRtp: 0.94,
    defaultMode: "default",
    maxWinMultiplier: 5000,
    modes: {
      default: { math, stakeMultiplier: 1, label: "Classic Slots — Free Spins" },
    },
  });
}

export default buildManifest;
