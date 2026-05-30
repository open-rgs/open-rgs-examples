-- crash.lua — the rising multiplier that can bust at any moment.
--
-- Each "hold" step advances the curve one tick; the tick survives with
-- probability p. Survive and the multiplier rises; bust and it's gone. Cash
-- out (CLOSE) to lock in the current multiplier. After t surviving ticks:
--
--     m_t = RTP / p^t
--
-- Under the hood this is the SAME survival ladder as Chicken Road — a constant
-- per-step hazard — just with a finer tick so it reads as a smooth curve, and
-- a "volatility" dial on p.
--
-- ── An honest limitation worth understanding ────────────────────────────────
-- A real crash game cashes out at the *live* multiplier the instant you click.
-- That needs a server-side clock to derive "where is the curve right now",
-- which open-rgs deliberately does NOT provide: there are no in-process timers
-- and autoclose is external-trigger only (ADR-003). So here progression is
-- CLIENT-DRIVEN: the client sends a "hold" step per tick (the server computes
-- and validates the multiplier — it's never client-claimed), and cashing out
-- is just closing at the last survived tick. A production live-crash would add
-- a trusted time oracle in front of this. The certifiable *core* — a fair
-- survival ladder — is exactly what's here.  (See docs/math-testing.md.)
--
-- `json` is injected by the lua-kit prelude.

local RTP = 0.99
local MAX_TICKS = 250

-- volatility → survival-per-tick. Lower p busts sooner but climbs faster.
local VOLATILITY = { low = 0.985, medium = 0.97, high = 0.94 }
local SIM_VOLATILITY = "medium"

return {
  kind = "complex",
  name = "crash",
  version = "1.0.0",
  rtp = RTP,
  expected = {
    -- simulator holds one tick then cashes: hit = p.
    hit_rate = { target = VOLATILITY[SIM_VOLATILITY], tolerance = 0.01 },
    rtp_contribution = { payout = { target = RTP, tolerance = 0.01 } },
  },

  open = function(_prev, ctx)
    local name = SIM_VOLATILITY
    if ctx and ctx.params and ctx.params.volatility then
      name = tostring(ctx.params.volatility)
    end
    local p = VOLATILITY[name] or VOLATILITY[SIM_VOLATILITY]
    local state = { tick = 0, p = p, volatility = name, busted = false }
    return {
      state = json.encode(state),
      ops = { { kind = "crash", action = "init", volatility = name, multiplier = 1.0 } },
      awaiting = { type = "hold", prompt = "Hold to ride the curve, or cash out" },
    }
  end,

  step = function(state_str, _action)
    local s = json.decode(state_str)
    if s.busted or s.tick >= MAX_TICKS then
      return { state = state_str, ops = {}, awaiting = nil }
    end

    if host.rng_next() < s.p then
      s.tick = s.tick + 1
      local mult = RTP / (s.p ^ s.tick)
      local awaiting = nil
      if s.tick < MAX_TICKS then
        awaiting = { type = "hold", prompt = "×" .. string.format("%.2f", mult) .. " — hold for more, or cash out" }
      end
      return {
        state = json.encode(s),
        ops = { { kind = "crash", action = "tick", tick = s.tick, multiplier = mult } },
        awaiting = awaiting,
      }
    end

    s.busted = true
    return {
      state = json.encode(s),
      ops = { { kind = "crash", action = "bust", tick = s.tick + 1 } },
    }
  end,

  is_terminal = function(state_str)
    local s = json.decode(state_str)
    return s.busted or s.tick >= 1
  end,

  close = function(state_str)
    local s = json.decode(state_str)
    if s.busted then
      host.mark.tag("bust")
      return { multiplier = 0, type = "bust", ops = { { kind = "crash", action = "settle", busted = true } } }
    end
    local mult = RTP / (s.p ^ s.tick)
    host.mark.tag("cashout")
    host.mark.contribute("payout", mult)
    return {
      multiplier = mult,
      type = "cashout",
      ops = { { kind = "crash", action = "settle", busted = false, tick = s.tick, multiplier = mult } },
    }
  end,

  autoclose = function(state_str)
    local s = json.decode(state_str)
    if s.busted then return { multiplier = 0, type = "autoclose-bust", ops = {} } end
    local mult = (s.tick >= 1) and (RTP / (s.p ^ s.tick)) or 0
    return { multiplier = mult, type = "autoclose", ops = { { kind = "crash", action = "autoclose", tick = s.tick, multiplier = mult } } }
  end,
}
