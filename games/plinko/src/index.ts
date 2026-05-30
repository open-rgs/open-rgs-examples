// plinko — server entry point.   bun run dev   (PORT to override 8080)

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

console.log(`🔺 plinko — ws://localhost:${port}/wss   ·   health: http://localhost:${port}/healthz`);
console.log(`   play a round:  bun run play --game plinko --params '{"rows":16,"risk":"high"}'`);
console.log(`   test the math: bun run sim  --game plinko`);
