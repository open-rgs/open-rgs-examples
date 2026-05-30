-- mines.lua — the canonical "survival ladder" complex round.
--
-- A 5×5 grid hides M mines. You reveal tiles one at a time; every safe reveal
-- ratchets the multiplier up. Hit a mine and you lose everything; cash out
-- (CLOSE the round) any time after the first safe tile to bank the current
-- multiplier.
--
-- The multiplier after k safe reveals is the FAIR one:
--
--     m_k = RTP / P(survive k tiles)
--
-- and because P(survive) is exactly the chance of getting this far, the
-- expected value of cashing out at *any* k is RTP. The house edge doesn't
-- depend on how brave you are — which is what makes the game certifiable and
-- lets the simulator measure the true RTP no matter how it plays.
--
-- Mines, Tower, Chicken Road and Crash are all this same ladder with a
-- different per-step survival probability. See docs/math-testing.md.
--
-- State is JSON, threaded as a string through open → step → close. `json`
-- (encode/decode) is injected as a chunk-local by @open-rgs-examples/lua-kit's
-- prelude — see that package for why it's a prelude and not a require() module.

local RTP   = 0.99
local TILES = 25
local SIM_MINES = 3   -- the mine count the simulator implicitly plays (no params)

-- P(reveal k safe tiles in a row) = product of (safe-i)/(remaining-i).
local function survive_prob(safe, k)
  local p = 1.0
  for i = 0, k - 1 do
    p = p * (safe - i) / (TILES - i)
  end
  return p
end

local function multiplier_for(safe, k)
  return RTP / survive_prob(safe, k)
end

-- Partial Fisher–Yates: the first `m` slots of a shuffled 0..TILES-1.
local function place_mines(m)
  local deck = {}
  for i = 1, TILES do deck[i] = i - 1 end
  for i = 1, m do
    local j = i + math.floor(host.rng_next() * (TILES - i + 1))
    deck[i], deck[j] = deck[j], deck[i]
  end
  local mines = {}
  for i = 1, m do mines[i] = deck[i] end
  table.sort(mines)
  return mines
end

local function has(arr, v)
  for _, x in ipairs(arr) do if x == v then return true end end
  return false
end

local function all_tiles()
  local t = {}
  for i = 0, TILES - 1 do t[#t + 1] = i end
  return t
end

local function unrevealed(revealed)
  local seen = {}
  for _, r in ipairs(revealed) do seen[r] = true end
  local opts = {}
  for t = 0, TILES - 1 do if not seen[t] then opts[#opts + 1] = t end end
  return opts
end

return {
  kind = "complex",
  name = "mines",
  version = "1.0.0",
  rtp = RTP,
  -- Targets below assume SIM_MINES and the simulator's "reveal one, cash out"
  -- play: hit rate = P(first tile safe) = (TILES-M)/TILES.
  expected = {
    hit_rate = { target = (TILES - SIM_MINES) / TILES, tolerance = 0.01 },
    tag_share = { cashout = { target = (TILES - SIM_MINES) / TILES, tolerance = 0.01 } },
    rtp_contribution = { payout = { target = RTP, tolerance = 0.01 } },
  },

  open = function(_prev, ctx)
    -- Safe client-param read: null/object/NaN can't crash us (see lua-kit).
    -- Clamped to [1, TILES-1] and floored to an integer.
    local m = params.num(ctx, "mines", SIM_MINES, 1, TILES - 1, true)

    local state = { mines = place_mines(m), revealed = {}, busted = false }
    return {
      state = json.encode(state),
      ops = { { kind = "mines", action = "init", tiles = TILES, mines = m } },
      awaiting = {
        type = "reveal",
        options = all_tiles(),
        prompt = "Pick a tile — " .. (TILES - m) .. " safe of " .. TILES,
      },
    }
  end,

  step = function(state_str, action)
    local s = json.decode(state_str)
    local safe = TILES - #s.mines
    local idx = math.floor(tonumber(action.value) or -1)

    -- Ignore an out-of-range / already-revealed pick (or a step after a bust):
    -- leave state untouched and re-offer the same choice.
    if s.busted or idx < 0 or idx >= TILES or has(s.revealed, idx) then
      local awaiting = nil
      if not s.busted then
        awaiting = { type = "reveal", options = unrevealed(s.revealed), prompt = "Pick a tile" }
      end
      return { state = state_str, ops = {}, awaiting = awaiting }
    end

    if has(s.mines, idx) then
      s.busted = true
      s.hit = idx
      -- No awaiting → the round is over; the player must CLOSE to settle (×0).
      return {
        state = json.encode(s),
        ops = { { kind = "mines", action = "reveal", index = idx, mine = true } },
      }
    end

    s.revealed[#s.revealed + 1] = idx
    local k = #s.revealed
    local mult = multiplier_for(safe, k)
    local remaining = safe - k

    local awaiting = nil
    if remaining > 0 then
      awaiting = {
        type = "reveal",
        options = unrevealed(s.revealed),
        prompt = "Cash out for ×" .. string.format("%.2f", mult) .. ", or pick another (" .. remaining .. " safe left)",
      }
    end
    return {
      state = json.encode(s),
      ops = { { kind = "mines", action = "reveal", index = idx, mine = false, picks = k, multiplier = mult } },
      awaiting = awaiting,
    }
  end,

  is_terminal = function(state_str)
    local s = json.decode(state_str)
    -- Closeable once busted (settle the loss) or after banking ≥1 safe tile.
    return s.busted or #s.revealed >= 1
  end,

  close = function(state_str)
    local s = json.decode(state_str)
    local safe = TILES - #s.mines
    if s.busted then
      host.mark.tag("bust")
      return {
        multiplier = 0,
        type = "bust",
        ops = { { kind = "mines", action = "settle", busted = true, mines = s.mines, hit = s.hit } },
      }
    end
    local k = #s.revealed
    local mult = multiplier_for(safe, k)
    local maxed = (k == safe)
    host.mark.tag(maxed and "max" or "cashout")
    host.mark.contribute("payout", mult)
    return {
      multiplier = mult,
      type = maxed and "max" or "cashout",
      ops = { { kind = "mines", action = "settle", busted = false, picks = k, multiplier = mult, mines = s.mines } },
    }
  end,

  -- settle-at-current autoclose: bank whatever is safe so far (0 if busted).
  autoclose = function(state_str)
    local s = json.decode(state_str)
    local safe = TILES - #s.mines
    if s.busted then return { multiplier = 0, type = "autoclose-bust", ops = {} } end
    local k = #s.revealed
    local mult = (k >= 1) and multiplier_for(safe, k) or 0
    return {
      multiplier = mult,
      type = "autoclose",
      ops = { { kind = "mines", action = "autoclose", picks = k, multiplier = mult } },
    }
  end,
}
