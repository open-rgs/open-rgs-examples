-- limbo.lua — the simplest provably-fair "originals" game.
--
-- The player picks a TARGET multiplier (>= 1.01). A random result R is drawn;
-- if R >= target the player wins `target` × their bet, otherwise nothing.
--
-- The result distribution is built so the house edge is CONSTANT regardless of
-- the chosen target:
--
--     P(R >= x) = RTP / x     for x >= 1
--
-- so for any target T:   EV = P(win) · T = (RTP / T) · T = RTP.
--
-- That target-independence matters twice over:
--   • the simulator can't pass a target, yet still measures the true RTP;
--   • no choice of target can beat the house — see docs/math-testing.md.

local RTP = 0.99
local MIN_TARGET, MAX_TARGET = 1.01, 1000000.0
local SIM_TARGET = 2.0   -- the target the simulator implicitly plays (no params)

return {
  kind = "simple",
  name = "limbo",
  version = "1.0.0",
  rtp = RTP,
  -- Author-declared targets the simulator checks against (assuming SIM_TARGET).
  expected = {
    hit_rate = { target = RTP / SIM_TARGET, tolerance = 0.01 },
    tag_share = { win = { target = RTP / SIM_TARGET, tolerance = 0.01 } },
    rtp_contribution = { payout = { target = RTP, tolerance = 0.01 } },
  },

  play = function(_prev, ctx)
    -- Player's chosen target. Defaults to 2.00 when none is supplied (the
    -- simulator never passes params, so this is what it measures).
    local target = SIM_TARGET
    if ctx and ctx.params and ctx.params.target then
      target = tonumber(ctx.params.target) or SIM_TARGET
    end
    if target < MIN_TARGET then target = MIN_TARGET end
    if target > MAX_TARGET then target = MAX_TARGET end

    -- Draw the result. With probability (1 - RTP) it busts at 1.00 (below any
    -- target); otherwise it's a heavy-tailed win-branch value in [1, inf) with
    -- P(R >= x | win-branch) = 1/x.
    local u = host.rng_next()                 -- [0, 1)
    local result
    if u >= RTP then
      result = 1.0                            -- the house edge lives here
    else
      local v = 1.0 - (u / RTP)               -- uniform on (0, 1]
      result = 1.0 / v                        -- [1, inf)
    end

    local won = result >= target
    local multiplier = won and target or 0.0

    if won then
      host.mark.tag("win")
      host.mark.contribute("payout", multiplier)
    else
      host.mark.tag("loss")
    end

    return {
      multiplier = multiplier,
      type = won and "win" or "loss",
      ops = { {
        kind   = "limbo",
        result = math.floor(result * 100) / 100,   -- 2 dp, for display only
        target = target,
        won    = won,
      } },
    }
  end,
}
