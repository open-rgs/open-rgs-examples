-- chicken-road.lua — get the chicken across the road, one lane at a time.
--
-- Each "cross" survives with probability p (set by difficulty). Survive and the
-- multiplier ticks up; get hit and you lose it all. Cash out (CLOSE) whenever.
--
-- It's the same survival ladder as Mines/Tower/Crash, but with a SINGLE action
-- ("cross") and no tile choice — the only decision is when to stop. After
-- crossing n lanes:
--
--     m_n = RTP / p^n
--
-- Difficulty just dials p (and the lane cap). Lower difficulty → cross more
-- lanes for small steps; higher → rarely survive but each lane pays big. The
-- house edge is the same constant RTP at every cash-out point.
--
-- `json` is injected by the lua-kit prelude.

local RTP = 0.99

-- difficulty → { survival-per-lane, max lanes }
local DIFFICULTY = {
  easy      = { p = 0.95, lanes = 20 },
  medium    = { p = 0.90, lanes = 20 },
  hard      = { p = 0.80, lanes = 16 },
  daredevil = { p = 0.60, lanes = 12 },
}
local SIM_DIFFICULTY = "medium"

return {
  kind = "complex",
  name = "chicken-road",
  version = "1.0.0",
  rtp = RTP,
  expected = {
    -- simulator crosses one lane then cashes: hit = p.
    hit_rate = { target = DIFFICULTY[SIM_DIFFICULTY].p, tolerance = 0.01 },
    rtp_contribution = { payout = { target = RTP, tolerance = 0.01 } },
  },

  open = function(_prev, ctx)
    local name = SIM_DIFFICULTY
    if ctx and ctx.params and ctx.params.difficulty then
      name = tostring(ctx.params.difficulty)
    end
    local cfg = DIFFICULTY[name] or DIFFICULTY[SIM_DIFFICULTY]
    local state = { lane = 0, p = cfg.p, max = cfg.lanes, difficulty = name, busted = false }
    return {
      state = json.encode(state),
      ops = { { kind = "chicken-road", action = "init", difficulty = name, lanes = cfg.lanes } },
      awaiting = { type = "cross", prompt = "Cross lane 1 of " .. cfg.lanes .. "?" },
    }
  end,

  step = function(state_str, _action)
    local s = json.decode(state_str)
    if s.busted or s.lane >= s.max then
      return { state = state_str, ops = {}, awaiting = nil }
    end

    if host.rng_next() < s.p then
      s.lane = s.lane + 1
      local mult = RTP / (s.p ^ s.lane)
      local awaiting = nil
      if s.lane < s.max then
        awaiting = { type = "cross", prompt = "Cash out for ×" .. string.format("%.2f", mult) .. ", or cross lane " .. (s.lane + 1) }
      end
      return {
        state = json.encode(s),
        ops = { { kind = "chicken-road", action = "cross", lane = s.lane, safe = true, multiplier = mult } },
        awaiting = awaiting,
      }
    end

    s.busted = true
    return {
      state = json.encode(s),
      ops = { { kind = "chicken-road", action = "cross", lane = s.lane + 1, safe = false } },
    }
  end,

  is_terminal = function(state_str)
    local s = json.decode(state_str)
    return s.busted or s.lane >= 1
  end,

  close = function(state_str)
    local s = json.decode(state_str)
    if s.busted then
      host.mark.tag("squashed")
      return { multiplier = 0, type = "squashed", ops = { { kind = "chicken-road", action = "settle", busted = true } } }
    end
    local mult = RTP / (s.p ^ s.lane)
    local across = (s.lane >= s.max)
    host.mark.tag(across and "across" or "cashout")
    host.mark.contribute("payout", mult)
    return {
      multiplier = mult,
      type = across and "across" or "cashout",
      ops = { { kind = "chicken-road", action = "settle", busted = false, lane = s.lane, multiplier = mult } },
    }
  end,

  autoclose = function(state_str)
    local s = json.decode(state_str)
    if s.busted then return { multiplier = 0, type = "autoclose-squashed", ops = {} } end
    local mult = (s.lane >= 1) and (RTP / (s.p ^ s.lane)) or 0
    return { multiplier = mult, type = "autoclose", ops = { { kind = "chicken-road", action = "autoclose", lane = s.lane, multiplier = mult } } }
  end,
}
