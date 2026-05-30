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
-- Currency-blind as always: we return a dimensionless multiplier; core does
-- `multiplier × bet`. `params` (safe reader) is injected by lua-kit.

local RTP = 0.94

-- Symbols. SCAT = scatter (triggers free spins), others are line-pay symbols.
-- Weights are per-reel-cell draw probabilities (must look plausible; the RTP is
-- whatever the sim measures — see tools/simulator).
local SYMBOLS = { "SCAT", "W", "A", "K", "Q", "J", "T", "N" }
local WEIGHT  = { SCAT = 2,  W = 3,  A = 6, K = 8, Q = 10, J = 12, T = 14, N = 16 }

-- 3-of-a-kind / 4 / 5 left-to-right pays (× line bet share). W substitutes.
-- Pays calibrated so the 10 lines + free spins integrate to ~RTP (sim-verified).
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

-- Build a weighted-pick closure over SYMBOLS/WEIGHT.
local TOTAL_W = 0
for _, s in ipairs(SYMBOLS) do TOTAL_W = TOTAL_W + WEIGHT[s] end
local function draw()
  local r = host.rng_next() * TOTAL_W
  local acc = 0
  for _, s in ipairs(SYMBOLS) do
    acc = acc + WEIGHT[s]
    if r < acc then return s end
  end
  return SYMBOLS[#SYMBOLS]
end

-- Spin a 5×3 grid: grid[reel][row], reel 1..5, row 1..3.
local function spin_grid()
  local g = {}
  for reel = 1, 5 do
    g[reel] = { draw(), draw(), draw() }
  end
  return g
end

local function count_scatters(g)
  local n = 0
  for reel = 1, 5 do
    for row = 1, 3 do
      if g[reel][row] == "SCAT" then n = n + 1 end
    end
  end
  return n
end

-- Evaluate the 10 lines. Line bet share = 1/#LINES of total bet, so multipliers
-- here are expressed as fractions of the TOTAL bet (paytable × (1/#lines)).
local LINE_SHARE = 1.0 / #LINES
local function evaluate_lines(g)
  local total = 0
  for _, line in ipairs(LINES) do
    -- symbols along the line, left to right
    local syms = {}
    for reel = 1, 5 do syms[reel] = g[reel][line[reel]] end
    -- leading symbol, treating W as wild: pick the first non-W as the pay sym
    local pay_sym = syms[1]
    if pay_sym == "W" then
      for reel = 2, 5 do if syms[reel] ~= "W" then pay_sym = syms[reel]; break end end
    end
    if pay_sym ~= "SCAT" and PAY[pay_sym] then
      local run = 0
      for reel = 1, 5 do
        local s = syms[reel]
        if s == pay_sym or s == "W" then run = run + 1 else break end
      end
      local p = PAY[pay_sym][run]
      if p then total = total + p * LINE_SHARE end
    end
  end
  return total
end

-- One free spin: lines pay 2× (classic FS boost); scatters don't re-trigger
-- here (kept simple — re-triggers are a variance knob, not a safety concern).
local FS_MULT = 2.0
local function free_spin()
  return evaluate_lines(spin_grid()) * FS_MULT
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
    local g = spin_grid()
    local base = evaluate_lines(g)
    local scatters = count_scatters(g)

    host.mark.contribute("base", base)
    local total = base
    local ops = { { kind = "slot", action = "spin", grid = g, base = base, scatters = scatters } }

    -- SCATTER triggers free spins, resolved RIGHT HERE — one atomic settle.
    local fs = FS_AWARD[scatters]
    if fs then
      local fs_total = 0
      local fs_results = {}
      for i = 1, fs do
        local w = free_spin()
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
