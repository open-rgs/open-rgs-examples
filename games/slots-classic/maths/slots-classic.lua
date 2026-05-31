-- slots-classic.lua — a 5×3, 10-line video slot with SCATTER-triggered free
-- spins, resolved ATOMICALLY inside the trigger spin.
--
-- ── Why this one is safe by construction ────────────────────────────────────
-- The whole feature — base spin AND any free spins it triggers — is computed
-- and paid in a SINGLE settle, at the bet of the spin that triggered it. There
-- is no cross-round state, no deferred payout, nothing the player can revisit at
-- a different bet. The win is one lump sum: `multiplier × bet`, settled once.
--
-- Contrast slots-meta, where the payout is deferred across many rounds and the
-- bet can change underneath it — that's the exploitable shape, and why it needs
-- a bet-aware adapter. Here, the math alone is sufficient. (See docs/slots.md.)
--
-- The reel/payline/scatter mechanics come from the `slot` kit (lua-kit prelude),
-- so this file is DATA — weights, a paytable, a line list — plus a few calls.
-- Currency-blind as always: we return a dimensionless multiplier; core does
-- `multiplier × bet`.

local RTP = 0.94
local REELS, ROWS = 5, 3

-- Symbols + per-cell draw weights. SCAT = scatter (triggers free spins),
-- W = wild (substitutes), rest are line-pay symbols.
local WEIGHTS = { SCAT = 2, W = 3, A = 6, K = 8, Q = 10, J = 12, T = 14, N = 16 }

-- 3/4/5-of-a-kind pays as a fraction of TOTAL bet per winning line (the kit
-- multiplies by lineShare = 1/#LINES). Calibrated so the game integrates to RTP.
local PAY = {
  W = { [3] = 40, [4] = 200, [5] = 750 },
  A = { [3] = 22, [4] = 90,  [5] = 380 },
  K = { [3] = 15, [4] = 60,  [5] = 220 },
  Q = { [3] = 11, [4] = 44,  [5] = 150 },
  J = { [3] = 7,  [4] = 30,  [5] = 110 },
  T = { [3] = 6,  [4] = 22,  [5] = 75  },
  N = { [3] = 4,  [4] = 15,  [5] = 60  },
}

-- 10 fixed paylines over a 5-wide × 3-high grid (row indices 1..3 per reel).
local LINES = {
  {2,2,2,2,2}, {1,1,1,1,1}, {3,3,3,3,3}, {1,2,3,2,1}, {3,2,1,2,3},
  {1,1,2,3,3}, {3,3,2,1,1}, {2,1,1,1,2}, {2,3,3,3,2}, {1,2,1,2,1},
}
local FS_AWARD = { [3] = 10, [4] = 15, [5] = 20 }   -- scatters → free-spin count
local FS_MULT = 2.0                                  -- free spins pay 2× on lines

-- The RTP autotuner injects PAY_SCALE (default 1) to solve the paytable scale
-- that hits a target RTP. Apply it once at load so the whole table scales.
local SCALE = PAY_SCALE or 1
if SCALE ~= 1 then
  for _, runs in pairs(PAY) do
    for k, v in pairs(runs) do runs[k] = v * SCALE end
  end
end

local draw = slot.reel(WEIGHTS)                      -- weighted sampler (kit)
local PAY_OPTS = { wild = "W", scatter = "SCAT", lineShare = 1.0 / #LINES }

-- A line evaluation over a fresh grid → win as a fraction of total bet.
local function eval_grid()
  local total = slot.paylines(slot.grid(draw, REELS, ROWS), LINES, PAY, PAY_OPTS)
  return total
end

return {
  kind = "simple",
  name = "slots-classic",
  version = "1.0.0",
  rtp = RTP,
  expected = {
    rtp_contribution = { base = { target = 0.70, tolerance = 0.12 }, freespins = { target = 0.24, tolerance = 0.12 } },
  },

  play = function(_prev, _ctx)
    local g = slot.grid(draw, REELS, ROWS)
    local base = slot.paylines(g, LINES, PAY, PAY_OPTS)
    local scatters = slot.count(g, "SCAT")

    host.mark.contribute("base", base)
    local total = base
    local ops = { { kind = "slot", action = "spin", grid = g, base = base, scatters = scatters } }

    -- SCATTER triggers free spins, resolved RIGHT HERE — one atomic settle.
    local fs = FS_AWARD[scatters]
    if fs then
      local fs_total = 0
      local fs_results = {}
      for i = 1, fs do
        local w = eval_grid() * FS_MULT
        fs_total = fs_total + w
        fs_results[i] = w
      end
      host.mark.contribute("freespins", fs_total)
      host.mark.tag("triggered_fs")
      total = total + fs_total
      ops[#ops + 1] = { kind = "slot", action = "freespins", count = fs, results = fs_results, fs_total = fs_total }
    end

    return {
      multiplier = total,
      type = (fs and "freespins") or (base > 0 and "win") or "loss",
      ops = ops,
      -- No carry: the round is fully self-contained. Nothing to roll forward,
      -- nothing to exploit at a different bet next round.
    }
  end,
}
