// blackjack — manifest builder. Complex round; json prelude. Abandoning a hand
// mid-play forfeits it, so autoclose is settle-as-loss (no math.autoclose).

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
  const math = await loadLuaMath(resolve(here, "../maths/blackjack.lua"), {
    rng: opts.rng ?? cryptoRng,
    timeoutMs: opts.timeoutMs ?? 1000,
    marks: opts.marks ?? false,
    extensions: exampleExtensions,
  });

  return defineGame({
    id: "blackjack",
    // This is the RTP UNDER BASIC STRATEGY — blackjack's return is set by how
    // it's played, not by the math alone (that's the whole point of this one).
    // Verified by `bun run sim --game blackjack --strategy basic`.
    declaredRtp: 0.974,
    defaultMode: "default",
    maxWinMultiplier: 3,
    autoclose: { idleMs: 300_000, policy: "settle-as-loss" },
    modes: {
      default: { math, stakeMultiplier: 1, label: "Blackjack" },
    },
  });
}

export default buildManifest;
