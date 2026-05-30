-- plinko.lua — a ball bounces down `rows` of pegs and lands in a bucket.
--
-- There is NO decision here: it's pure variance. The teaching point is the
-- payout table. Bucket b (0..rows) is reached with binomial probability
-- C(rows, b) / 2^rows. We pick a relative payout SHAPE (edges high, centre
-- low) and then scale the whole table by one constant so that
--
--     Σ  P(b) · payout(b)  =  RTP
--
-- i.e. the table is *solved* to the target RTP rather than guessed. Change the
-- risk and the shape steepens, but the normalisation keeps RTP at 0.99.

local RTP = 0.99
local DEFAULT_ROWS = 16
local RISK_RATIO = { low = 1.3, medium = 1.6, high = 2.1 }
local SIM_ROWS, SIM_RISK = DEFAULT_ROWS, "medium"

-- C(n, k) via the multiplicative formula (no big factorials).
local function binom(n, k)
  if k < 0 or k > n then return 0 end
  if k > n - k then k = n - k end
  local r = 1.0
  for i = 1, k do r = r * (n - k + i) / i end
  return r
end

-- Solve a payout table for (rows, ratio) normalised to RTP.
local function build_payouts(rows, ratio)
  local total = 2.0 ^ rows
  local center = rows / 2.0
  local probs, shape, weighted = {}, {}, 0.0
  for b = 0, rows do
    local p = binom(rows, b) / total
    local m = ratio ^ math.abs(b - center)
    probs[b], shape[b] = p, m
    weighted = weighted + p * m
  end
  local k = RTP / weighted
  local payouts = {}
  for b = 0, rows do payouts[b] = shape[b] * k end
  return payouts
end

-- Precompute the default table once at module load.
local default_payouts = build_payouts(SIM_ROWS, RISK_RATIO[SIM_RISK])

return {
  kind = "simple",
  name = "plinko",
  version = "1.0.0",
  rtp = RTP,
  expected = {
    rtp_contribution = { payout = { target = RTP, tolerance = 0.01 } },
  },

  play = function(_prev, ctx)
    -- Safe client-param reads (null/object/NaN can't crash us — see lua-kit).
    -- rows clamped to [8, 20] & floored; risk restricted to the known set.
    local rows = params.num(ctx, "rows", SIM_ROWS, 8, 20, true)
    local risk = params.str(ctx, "risk", SIM_RISK, { low = true, medium = true, high = true })
    local ratio = RISK_RATIO[risk] or RISK_RATIO[SIM_RISK]
    local payouts = (rows == SIM_ROWS and risk == SIM_RISK)
      and default_payouts or build_payouts(rows, ratio)

    -- Drop the ball: one coin flip per row, count how many go right.
    local bucket = 0
    for _ = 1, rows do
      if host.rng_next() < 0.5 then bucket = bucket + 1 end
    end
    local mult = payouts[bucket]

    host.mark.contribute("payout", mult)
    host.mark.tag(mult >= 1 and "win" or "below_1x")

    return {
      multiplier = mult,
      type = mult >= 1 and "win" or "small",
      ops = { { kind = "plinko", rows = rows, risk = risk, bucket = bucket, multiplier = mult } },
    }
  end,
}
