// @open-rgs-examples/lua-kit
//
// Lua extensions shared by the example games. An open-rgs LuaExtension is
// registered per-math at load time — `loadLuaMath(path, { extensions })`. See
// @open-rgs/contract's LuaExtension type and specs/03-math-runtime.md.
//
// Two concerns:
//   • `json`   — serialize a complex round's RoundState (open/step/close thread
//                a *string*, and stock Lua has no JSON).
//   • `params` — read client-supplied ctx.params SAFELY. The client controls
//                params over the wire; a math file must never trust its shape.
//                Critically, wasmoon marshals a JSON/msgpack `null` as a truthy
//                userdata SENTINEL, so `if params.x then tonumber(params.x)`
//                detonates the VM (INTERNAL_ERROR) on `{ x: null }` — a remote
//                crash. params.num/str/bool only accept real primitives and
//                fall back to a default otherwise. (Found by tools/attack.)
//
// Both are injected as a PRELUDE via the extension `transform` hook rather than
// as `require()`-able modules, and that choice is load-bearing:
//
//   • A `require("json")` module is round-tripped through JS by the loader, so
//     a pure-Lua decode() would hand back userdata PROXIES. Those support field
//     reads but NOT `#t`, `ipairs`, or table mutation — which is exactly what a
//     game does to its decoded state. (A host/TS JSON has the same problem on
//     the decode *return*.)
//   • A prelude keeps the code inside the math's own chunk, so decode() builds
//     NATIVE Lua tables. `#state.revealed`, `ipairs`, and append all work.
//
// Each transform wraps its .lua in an IIFE assigned to one chunk-local; the
// helpers' own internals stay scoped inside the IIFE. Math files just use
// `json.encode` / `params.num` etc. (no `require`).

import { readFileSync } from "node:fs";
import type { LuaExtension } from "@open-rgs/contract";

// Real .lua files (syntax highlighting, no backslash-escaping war in a TS
// string). Each ends with `return <module>`; the IIFE captures that.
const jsonLua = readFileSync(new URL("./json.lua", import.meta.url), "utf8");
const paramsLua = readFileSync(new URL("./params.lua", import.meta.url), "utf8");
const slotLua = readFileSync(new URL("./slot.lua", import.meta.url), "utf8");

/** Injects `local json = { encode, decode }` at the top of the math file. */
export const jsonExtension: LuaExtension = {
  name: "json",
  version: "0.1.0",
  transform: (source: string) => `local json = (function()\n${jsonLua}\nend)()\n${source}`,
};

/** Injects `local params = { num, str, bool }` — safe client-param reads. */
export const paramsExtension: LuaExtension = {
  name: "params",
  version: "0.1.0",
  transform: (source: string) => `local params = (function()\n${paramsLua}\nend)()\n${source}`,
};

/** Injects `local slot = { reel, grid, count, paylines }` — the reel/payline/
 *  scatter boilerplate, so a slot author writes data + a few calls, not loops. */
export const slotExtension: LuaExtension = {
  name: "slot",
  version: "0.1.0",
  transform: (source: string) => `local slot = (function()\n${slotLua}\nend)()\n${source}`,
};

/** For simple games: just the safe param reader. */
export const paramsOnly: readonly LuaExtension[] = [paramsExtension];

/** For complex games: JSON state codec + safe param reader. */
export const exampleExtensions: readonly LuaExtension[] = [jsonExtension, paramsExtension];

/** For slot games: the slot kit + safe param reader (add jsonExtension too if
 *  the slot carries cross-round state, like slots-meta). */
export const slotKit: readonly LuaExtension[] = [slotExtension, paramsExtension];
export const slotKitWithState: readonly LuaExtension[] = [slotExtension, paramsExtension, jsonExtension];
