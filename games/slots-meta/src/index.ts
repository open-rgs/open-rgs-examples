// slots-meta — server entry point. Uses the bet-aware MetaPlatform (stake-lock
// + rollback-safe carry), NOT the plain mock — the deferred bonus payout is only
// safe with that adapter underneath.   bun run dev   (PORT to override 8080)

import { createServer, binaryTransport } from "@open-rgs/core";
import { MetaPlatform } from "@open-rgs-examples/meta-platform";
import { buildManifest } from "./manifest";

const port = Number(process.env["PORT"] ?? 8080);

await createServer({
  manifest: await buildManifest(),
  platform: new MetaPlatform({ startingBalance: 100_000 }),
  transport: binaryTransport({ port }),
  version: "1.0.0",
});

console.log(`🎯 slots-meta — ws://localhost:${port}/wss   ·   health: http://localhost:${port}/healthz`);
console.log(`   collect 10 scatters → bonus. Bet is LOCKED while progress > 0.`);
console.log(`   play a round:  bun run play --game slots-meta`);
console.log(`   attack it:     bun run attack --game slots-meta   (bet-switch + rollback)`);
