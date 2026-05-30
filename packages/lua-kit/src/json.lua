-- json.lua — a tiny, self-contained JSON codec, in pure Lua.
--
-- @open-rgs-examples/lua-kit injects this as a PRELUDE (a source transform):
-- loadLuaMath wraps it as `local json = (function() ...this... end)()` and
-- prepends it to the math file, so `json` is an ordinary local in the math's
-- own chunk. That matters: decode() builds NATIVE Lua tables, so the math can
-- use `#t`, `ipairs`, and table mutation on decoded state. (Going through the
-- extension `require()` path instead would round-trip the codec through JS and
-- hand back userdata proxies that don't support those — see lua-kit/index.ts.)
--
-- Scope: enough JSON for game state — nil/boolean/number/string/array/object.
-- It round-trips whatever json.encode produces; it is not a spec-complete
-- validator.

local json = {}

-- ── encode ────────────────────────────────────────────────────────────────

local escapes = {
  ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r',
  ['\t'] = '\\t', ['\b'] = '\\b', ['\f'] = '\\f',
}

local function escape_str(s)
  return (s:gsub('[%z\1-\31\\"]', function(c)
    return escapes[c] or string.format('\\u%04x', string.byte(c))
  end))
end

-- A Lua table encodes as a JSON array iff its keys are exactly 1..n
-- (contiguous, integer, 1-based). The empty table encodes as [].
local function array_len(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k % 1 ~= 0 or k < 1 then return nil end
    if k > n then n = k end
  end
  local count = 0
  for _ in pairs(t) do count = count + 1 end
  if count == n then return n end
  return nil
end

local encode_value

local function encode_table(t, out)
  local n = array_len(t)
  if n ~= nil then
    out[#out + 1] = "["
    for i = 1, n do
      if i > 1 then out[#out + 1] = "," end
      encode_value(t[i], out)
    end
    out[#out + 1] = "]"
  else
    out[#out + 1] = "{"
    local first = true
    for k, v in pairs(t) do
      if not first then out[#out + 1] = "," end
      first = false
      out[#out + 1] = '"' .. escape_str(tostring(k)) .. '":'
      encode_value(v, out)
    end
    out[#out + 1] = "}"
  end
end

encode_value = function(v, out)
  local tv = type(v)
  if v == nil then
    out[#out + 1] = "null"
  elseif tv == "boolean" then
    out[#out + 1] = v and "true" or "false"
  elseif tv == "number" then
    if v ~= v or v == math.huge or v == -math.huge then
      error("json: cannot encode non-finite number")
    elseif v % 1 == 0 then
      out[#out + 1] = string.format("%d", v)   -- keep integers clean (25, not 25.0)
    else
      out[#out + 1] = tostring(v)
    end
  elseif tv == "string" then
    out[#out + 1] = '"' .. escape_str(v) .. '"'
  elseif tv == "table" then
    encode_table(v, out)
  else
    error("json: cannot encode value of type " .. tv)
  end
end

function json.encode(value)
  local out = {}
  encode_value(value, out)
  return table.concat(out)
end

-- ── decode ──────────────────────────────────────────────────────────────────
-- Single-threaded VM, so module-level cursor state is safe: decode() is never
-- re-entered from outside while a parse is in flight.

local s, pos

local function err(msg) error("json decode @" .. tostring(pos) .. ": " .. msg) end

local function skip_ws()
  local _, e = s:find("^[ \t\r\n]+", pos)
  if e then pos = e + 1 end
end

local function parse_string()
  pos = pos + 1 -- opening quote
  local buf = {}
  while true do
    local c = s:sub(pos, pos)
    if c == "" then err("unterminated string") end
    if c == '"' then pos = pos + 1; return table.concat(buf) end
    if c == "\\" then
      local e = s:sub(pos + 1, pos + 1)
      if     e == "n" then buf[#buf + 1] = "\n"
      elseif e == "t" then buf[#buf + 1] = "\t"
      elseif e == "r" then buf[#buf + 1] = "\r"
      elseif e == "b" then buf[#buf + 1] = "\b"
      elseif e == "f" then buf[#buf + 1] = "\f"
      elseif e == "/" then buf[#buf + 1] = "/"
      elseif e == '"' then buf[#buf + 1] = '"'
      elseif e == "\\" then buf[#buf + 1] = "\\"
      elseif e == "u" then
        local code = tonumber(s:sub(pos + 2, pos + 5), 16) or err("bad \\u escape")
        if code < 0x80 then
          buf[#buf + 1] = string.char(code)
        elseif code < 0x800 then
          buf[#buf + 1] = string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
        else
          buf[#buf + 1] = string.char(
            0xE0 + math.floor(code / 0x1000),
            0x80 + math.floor(code / 0x40) % 0x40,
            0x80 + code % 0x40)
        end
        pos = pos + 4
      else err("bad escape \\" .. e) end
      pos = pos + 2
    else
      buf[#buf + 1] = c
      pos = pos + 1
    end
  end
end

local parse_value

local function parse_object()
  pos = pos + 1 -- "{"
  local obj = {}
  skip_ws()
  if s:sub(pos, pos) == "}" then pos = pos + 1; return obj end
  while true do
    skip_ws()
    if s:sub(pos, pos) ~= '"' then err("expected string key") end
    local key = parse_string()
    skip_ws()
    if s:sub(pos, pos) ~= ":" then err("expected ':'") end
    pos = pos + 1
    obj[key] = parse_value()
    skip_ws()
    local c = s:sub(pos, pos)
    if c == "," then pos = pos + 1
    elseif c == "}" then pos = pos + 1; return obj
    else err("expected ',' or '}'") end
  end
end

local function parse_array()
  pos = pos + 1 -- "["
  local arr = {}
  skip_ws()
  if s:sub(pos, pos) == "]" then pos = pos + 1; return arr end
  local i = 0
  while true do
    i = i + 1
    arr[i] = parse_value()
    skip_ws()
    local c = s:sub(pos, pos)
    if c == "," then pos = pos + 1
    elseif c == "]" then pos = pos + 1; return arr
    else err("expected ',' or ']'") end
  end
end

parse_value = function()
  skip_ws()
  local c = s:sub(pos, pos)
  if c == "{" then return parse_object()
  elseif c == "[" then return parse_array()
  elseif c == '"' then return parse_string()
  elseif c == "t" then
    if s:sub(pos, pos + 3) == "true" then pos = pos + 4; return true end
    err("invalid literal")
  elseif c == "f" then
    if s:sub(pos, pos + 4) == "false" then pos = pos + 5; return false end
    err("invalid literal")
  elseif c == "n" then
    if s:sub(pos, pos + 3) == "null" then pos = pos + 4; return nil end
    err("invalid literal")
  else
    local num = s:match("^%-?[0-9.eE+%-]+", pos)
    if not num then err("unexpected character '" .. c .. "'") end
    pos = pos + #num
    return tonumber(num) or err("invalid number '" .. num .. "'")
  end
end

function json.decode(str)
  s, pos = str, 1
  local value = parse_value()
  s = nil -- release the reference
  return value
end

return json
