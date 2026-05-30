// @open-rgs-examples/lua-kit
//
// Lua extensions shared by the example games. An open-rgs LuaExtension is
// registered per-math at load time — `loadLuaMath(path, { extensions })`. See
// @open-rgs/contract's LuaExtension type and specs/03-math-runtime.md.
//
// Today there's exactly one concern: `json`, used by the complex games to
// serialize their RoundState (open/step/close thread a *string*, and the
// natural way to carry structured state in a string is JSON — which stock Lua
// lacks).
//
// We inject it as a PRELUDE via the extension `transform` hook rather than as a
// `require()`-able module, and that choice is load-bearing:
//
//   • A `require("json")` module is round-tripped through JS by the loader, so
//     a pure-Lua decode() would hand back userdata PROXIES. Those support field
//     reads but NOT `#t`, `ipairs`, or table mutation — which is exactly what a
//     game does to its decoded state. (A host/TS JSON has the same problem on
//     the decode *return*.)
//   • A prelude keeps the codec inside the math's own chunk, so decode() builds
//     NATIVE Lua tables. `#state.revealed`, `ipairs`, and append all work.
//
// The transform wraps json.lua in an IIFE assigned to a single chunk-local
// `json`; the codec's own helpers stay scoped inside the IIFE. Complex math
// files just use `json.encode` / `json.decode` (no `require`).

import { readFileSync } from "node:fs";
import type { LuaExtension } from "@open-rgs/contract";

// json.lua is a real .lua file (syntax highlighting, no backslash-escaping war
// inside a TS string). It ends with `return json`; the IIFE captures that.
const jsonLua = readFileSync(new URL("./json.lua", import.meta.url), "utf8");

/** Injects `local json = { encode, decode }` at the top of every math file it
 *  is registered with. Use `json.encode(value)` / `json.decode(string)`. */
export const jsonExtension: LuaExtension = {
  name: "json",
  version: "0.1.0",
  transform: (source: string) => `local json = (function()\n${jsonLua}\nend)()\n${source}`,
};

/** The standard extension set the example complex games load. */
export const exampleExtensions: readonly LuaExtension[] = [jsonExtension];
