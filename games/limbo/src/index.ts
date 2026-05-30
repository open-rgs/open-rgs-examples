// limbo — server entry point. One Bun file boots a working RGS:
// Lua math + a logging mock wallet + binary-msgpack on the wire.
//
//   bun run dev            # from games/limbo
//   PORT=8090 bun run dev  # pick a port

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

console.log(`🚀 limbo — ws://localhost:${port}/wss   ·   health: http://localhost:${port}/healthz`);
console.log(`   play a round:  bun run play --game limbo     (from the repo root)`);
console.log(`   test the math: bun run sim  --game limbo     (from the repo root)`);
