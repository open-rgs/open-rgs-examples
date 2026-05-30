-- tower.lua — climb a tower, one row at a time.
--
-- Each row has `tiles` cells, `danger` of them fatal. You pick one cell per
-- row; a safe pick climbs you up and ratchets the multiplier, a fatal pick
-- ends the run. Cash out (CLOSE) any time after the first row.
--
-- This is Mines with a CONSTANT per-step survival probability instead of a
-- shrinking one. Per row, survival p = (tiles - danger) / tiles, so after
-- climbing r rows:
--
--     m_r = RTP / p^r
--
-- Same constant-EV ladder, same certifiable house edge. See mines.lua for the
-- fully-commented version of the pattern; `json` is injected by the lua-kit
-- prelude.

local RTP = 0.99
local SIM_ROWS, SIM_TILES, SIM_DANGER = 8, 3, 1   -- the simulator's defaults

local function survival(tiles, danger)
  return (tiles - danger) / tiles
end

-- Pre-draw one set of danger cells per row (provably-fair: the layout is fixed
-- at open, not invented as you climb).
local function build_dangers(rows, tiles, danger)
  local layout = {}
  for r = 1, rows do
    local cells = {}
    for c = 0, tiles - 1 do cells[c + 1] = c end
    -- partial shuffle: first `danger` cells become the fatal ones
    for i = 1, danger do
      local j = i + math.floor(host.rng_next() * (tiles - i + 1))
      cells[i], cells[j] = cells[j], cells[i]
    end
    local row = {}
    for i = 1, danger do row[i] = cells[i] end
    table.sort(row)
    layout[r] = row
  end
  return layout
end

local function has(arr, v)
  for _, x in ipairs(arr) do if x == v then return true end end
  return false
end

local function tiles_list(tiles)
  local t = {}
  for c = 0, tiles - 1 do t[#t + 1] = c end
  return t
end

return {
  kind = "complex",
  name = "tower",
  version = "1.0.0",
  rtp = RTP,
  expected = {
    -- simulator climbs one row then cashes: hit = P(survive 1 row).
    hit_rate = { target = survival(SIM_TILES, SIM_DANGER), tolerance = 0.01 },
    rtp_contribution = { payout = { target = RTP, tolerance = 0.01 } },
  },

  open = function(_prev, ctx)
    local rows, tiles, danger = SIM_ROWS, SIM_TILES, SIM_DANGER
    if ctx and ctx.params then
      if ctx.params.rows then rows = math.floor(tonumber(ctx.params.rows) or rows) end
      if ctx.params.tiles then tiles = math.floor(tonumber(ctx.params.tiles) or tiles) end
      if ctx.params.danger then danger = math.floor(tonumber(ctx.params.danger) or danger) end
    end
    if tiles < 2 then tiles = 2 end
    if rows < 1 then rows = 1 end
    if danger < 1 then danger = 1 end
    if danger > tiles - 1 then danger = tiles - 1 end

    local state = {
      dangers = build_dangers(rows, tiles, danger),
      tiles = tiles, danger = danger, rows = rows,
      climbed = 0, busted = false,
    }
    return {
      state = json.encode(state),
      ops = { { kind = "tower", action = "init", rows = rows, tiles = tiles, danger = danger } },
      awaiting = {
        type = "climb",
        options = tiles_list(tiles),
        prompt = "Row 1 of " .. rows .. " — pick one of " .. tiles .. " (" .. danger .. " fatal)",
      },
    }
  end,

  step = function(state_str, action)
    local s = json.decode(state_str)
    if s.busted or s.climbed >= s.rows then
      return { state = state_str, ops = {}, awaiting = nil }
    end
    local pick = math.floor(tonumber(action.value) or -1)
    local nextRow = s.climbed + 1
    local fatal = s.dangers[nextRow] or {}

    if has(fatal, pick) then
      s.busted = true
      return {
        state = json.encode(s),
        ops = { { kind = "tower", action = "climb", row = nextRow, pick = pick, fatal = true } },
      }
    end

    s.climbed = nextRow
    local p = survival(s.tiles, s.danger)
    local mult = RTP / (p ^ s.climbed)
    local awaiting = nil
    if s.climbed < s.rows then
      awaiting = {
        type = "climb",
        options = tiles_list(s.tiles),
        prompt = "Cash out for ×" .. string.format("%.2f", mult) .. ", or climb row " .. (s.climbed + 1),
      }
    end
    return {
      state = json.encode(s),
      ops = { { kind = "tower", action = "climb", row = s.climbed, pick = pick, fatal = false, multiplier = mult } },
      awaiting = awaiting,
    }
  end,

  is_terminal = function(state_str)
    local s = json.decode(state_str)
    return s.busted or s.climbed >= 1
  end,

  close = function(state_str)
    local s = json.decode(state_str)
    if s.busted then
      host.mark.tag("fall")
      return { multiplier = 0, type = "fall", ops = { { kind = "tower", action = "settle", busted = true, dangers = s.dangers } } }
    end
    local p = survival(s.tiles, s.danger)
    local mult = RTP / (p ^ s.climbed)
    local topped = (s.climbed >= s.rows)
    host.mark.tag(topped and "top" or "cashout")
    host.mark.contribute("payout", mult)
    return {
      multiplier = mult,
      type = topped and "top" or "cashout",
      ops = { { kind = "tower", action = "settle", busted = false, climbed = s.climbed, multiplier = mult, dangers = s.dangers } },
    }
  end,

  autoclose = function(state_str)
    local s = json.decode(state_str)
    if s.busted then return { multiplier = 0, type = "autoclose-fall", ops = {} } end
    local mult = (s.climbed >= 1) and (RTP / (survival(s.tiles, s.danger) ^ s.climbed)) or 0
    return { multiplier = mult, type = "autoclose", ops = { { kind = "tower", action = "autoclose", climbed = s.climbed, multiplier = mult } } }
  end,
}
