-- dice.lua — classic over/under dice.
--
-- A roll lands uniformly in [0.00, 100.00). You pick a target and a direction
-- (roll under, or roll over). The payout is set from the win chance:
--
--     payout = RTP / win_chance
--
-- so EV = win_chance · payout = RTP for any target. Sliding the target trades
-- win chance against payout but never moves the house edge — the same
-- constant-EV property Limbo has, just exposed as a probability instead of a
-- multiplier. (See docs/math-testing.md.)

local RTP = 0.99
local SIM_TARGET, SIM_OVER = 50.0, false   -- the simulator plays "roll under 50"

return {
  kind = "simple",
  name = "dice",
  version = "1.0.0",
  rtp = RTP,
  expected = {
    hit_rate = { target = SIM_TARGET / 100.0, tolerance = 0.01 },
    rtp_contribution = { payout = { target = RTP, tolerance = 0.01 } },
  },

  play = function(_prev, ctx)
    local target, over = SIM_TARGET, SIM_OVER
    if ctx and ctx.params then
      if ctx.params.target then target = tonumber(ctx.params.target) or target end
      if ctx.params.over ~= nil then over = ctx.params.over and true or false end
    end
    if target < 0.01 then target = 0.01 end
    if target > 99.99 then target = 99.99 end

    local roll = host.rng_next() * 100.0   -- [0, 100)
    local win_chance, won
    if over then
      win_chance = (100.0 - target) / 100.0
      won = roll > target
    else
      win_chance = target / 100.0
      won = roll < target
    end
    local payout = won and (RTP / win_chance) or 0.0

    if won then
      host.mark.tag("win")
      host.mark.contribute("payout", payout)
    else
      host.mark.tag("loss")
    end

    return {
      multiplier = payout,
      type = won and "win" or "loss",
      ops = { {
        kind = "dice",
        roll = math.floor(roll * 100) / 100,   -- 2 dp
        target = target,
        over = over,
        won = won,
      } },
    }
  end,
}
