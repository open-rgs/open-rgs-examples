-- params.lua — safe reads of client-supplied SpinContext params.
--
-- ctx.params comes straight from the client over the wire. An attacker controls
-- it completely, so a math file must NEVER trust its shape. The trap this guards
-- against: wasmoon marshals a JSON/msgpack `null` into a userdata SENTINEL, not
-- Lua `nil`. So the natural-looking
--
--     if ctx.params.target then x = tonumber(ctx.params.target) end
--
-- passes the truthy check on `target: null`, then `tonumber(<userdata>)` throws
-- inside the VM bridge → the whole round dies with INTERNAL_ERROR. A remote
-- client can crash any round that reads a param by sending `{ field: null }`.
-- (Found by tools/attack — see docs/security.md.)
--
-- These readers accept ONLY a real number or a real string and clamp to range;
-- anything else (null/userdata, table, NaN, ±inf, out-of-range) falls back to
-- the default. Injected as a chunk-local `params` by @open-rgs-examples/lua-kit.

local params = {}

-- Pull a raw value only if ctx.params is a plain table and the key holds a
-- primitive of the wanted Lua type. userdata (the null sentinel), tables, and
-- functions all return nil → caller uses its default.
local function raw(ctx, key, want)
  if type(ctx) ~= "table" then return nil end
  local p = ctx.params
  if type(p) ~= "table" then return nil end
  local v = p[key]
  if type(v) ~= want then return nil end
  return v
end

-- params.num(ctx, key, default [, min, max [, integer]])
-- Returns a finite number, clamped to [min, max], optionally floored to an int.
function params.num(ctx, key, default, min, max, integer)
  local v = raw(ctx, key, "number")
  -- reject NaN (v ~= v) and ±infinity
  if v == nil or v ~= v or v == math.huge or v == -math.huge then return default end
  if integer then v = math.floor(v) end
  if min ~= nil and v < min then v = min end
  if max ~= nil and v > max then v = max end
  return v
end

-- params.str(ctx, key, default [, allowed])
-- Returns a string; if `allowed` (a set-like table { value = true }) is given,
-- only a member passes, else the default.
function params.str(ctx, key, default, allowed)
  local v = raw(ctx, key, "string")
  if v == nil then return default end
  if allowed ~= nil and not allowed[v] then return default end
  return v
end

-- params.bool(ctx, key, default) — only a real boolean overrides the default.
function params.bool(ctx, key, default)
  local v = raw(ctx, key, "boolean")
  if v == nil then return default end
  return v
end

return params
