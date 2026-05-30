// mines — server entry point. A complex round: open debits the bet, each step
// reveals a tile, close credits the cashed-out multiplier.
//
//   bun run dev            # from games/mines
//   PORT=8084 bun run dev

import { createServer, binaryTransport } from "@open-rgs/core";
import { LoggingMockPlatform } from "@open-rgs-examples/mock-platform";
import { buildManifest } from "./manifest";

const port = Number(process.env["PORT"] ?? 8080);

await createServer({
  manifest: await buildManifest(),
  platform: new LoggingMockPlatform({ startingBalance: 100_000 }),
  transport: binaryTransport({ port }),
  version: "1.0.0",
});

console.log(`💣 mines — ws://localhost:${port}/wss   ·   health: http://localhost:${port}/healthz`);
console.log(`   play a round:  bun run play --game mines --steps 4   (from the repo root)`);
console.log(`   test the math: bun run sim  --game mines --compare    (from the repo root)`);
