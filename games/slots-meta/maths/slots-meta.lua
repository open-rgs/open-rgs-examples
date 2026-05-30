-- slots-meta.lua — a slot with META-PROGRESSION.
--
-- Unlike a normal scatter (which triggers a feature on the spin it lands),
-- here a SCATTER gives +1 PROGRESS toward a goal that persists ACROSS ROUNDS.
-- At GOAL (10) progress, the next contributing spin awards a BONUS payout and
-- resets progress to 0.
--
--   scatter hit            → progress += (number of scatters this spin)
--   progress reaches 10    → pay BONUS (× bet), reset progress to 0
--   base line wins         → pay normally every spin (independent of progress)
--
-- ── Why this shape is dangerous (read this) ─────────────────────────────────
-- The bonus is a DEFERRED payout: progress is earned over many cheap spins and
-- cashed on one spin that pays `BONUS × bet`. The math is currency-blind — it
-- CANNOT see the bet — so on its own it cannot stop a player accumulating 9
-- progress at min bet and triggering the 10th at max bet (a 50× value transfer),
-- nor stop a player rolling back the trigger round to keep both the bonus and
-- the progress. Those defenses CANNOT live here. They live in the adapter
-- (@open-rgs-examples/meta-platform): a stake-lock pins the bet for the whole
-- accumulation, and (balance, carry) commit + roll back together.
--
-- So this math's only job is to be HONEST and DETERMINISTIC about progress:
-- read it from carry, advance it, pay the bonus exactly when it crosses the
-- goal, and write the new progress back. It must never pay the bonus twice for
-- one crossing, and must reset cleanly. The adapter does the bet-aware part.
--
-- Carry format (shared with the adapter): {"progress":<int>,"lockedBet":<n|nil>}.
-- We only read/write `progress`; we always emit lockedBet=nil and let the
-- ADAPTER own the lock (single source of truth — the math can't be trusted with
-- it, since a forked client could lie). `json`/`params` injected by lua-kit.

local RTP_BASE  = 0.80   -- RTP delivered by ordinary line wins, every spin
local RTP_BONUS = 0.14   -- RTP delivered by the meta bonus, amortised per spin
-- (declared total ≈ 0.94; the sim verifies the realised figure.)

local GOAL = 10          -- progress needed to fire the bonus

-- Symbols + per-cell weights (5×3 grid). SCAT advances progress.
local SYMBOLS = { "SCAT", "A", "K", "Q", "J", "T", "N" }
local WEIGHT  = { SCAT = 3, A = 6, K = 8, Q = 10, J = 12, T = 14, N = 16 }

-- Line pays as a fraction of total bet (3/4/5 of a kind, left to right).
-- Calibrated (with the weights/lines below) so base RTP ≈ RTP_BASE — sim-checked.
local PAY = {
  A = { [3] = 46, [4] = 180, [5] = 760 },
  K = { [3] = 31, [4] = 122, [5] = 460 },
  Q = { [3] = 23, [4] = 92,  [5] = 306 },
  J = { [3] = 15, [4] = 61,  [5] = 230 },
  T = { [3] = 13, [4] = 46,  [5] = 153 },
  N = { [3] = 8,  [4] = 31,  [5] = 122 },
}
local LINES = {
  {2,2,2,2,2}, {1,1,1,1,1}, {3,3,3,3,3}, {1,2,3,2,1}, {3,2,1,2,3},
  {1,1,2,3,3}, {3,3,2,1,1}, {2,1,1,1,2}, {2,3,3,3,2}, {1,2,1,2,1},
}
local LINE_SHARE = 1.0 / #LINES

-- The bonus pays a fixed multiple of bet when progress hits the goal. We size it
-- so its amortised contribution ≈ RTP_BONUS:
--   a scatter lands with some rate; GOAL scatters take ~GOAL/scatter_rate spins;
--   BONUS_PAY / (spins per bonus) ≈ RTP_BONUS. The sim confirms the realised %.
local BONUS_PAY = 2.1

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

local function spin_grid()
  local g = {}
  for reel = 1, 5 do g[reel] = { draw(), draw(), draw() } end
  return g
end

local function count_scatters(g)
  local n = 0
  for reel = 1, 5 do for row = 1, 3 do if g[reel][row] == "SCAT" then n = n + 1 end end end
  return n
end

local function evaluate_lines(g)
  local total = 0
  for _, line in ipairs(LINES) do
    local first = g[1][line[1]]
    if first ~= "SCAT" and PAY[first] then
      local run = 0
      for reel = 1, 5 do
        if g[reel][line[reel]] == first then run = run + 1 else break end
      end
      local p = PAY[first][run]
      if p then total = total + p * LINE_SHARE end
    end
  end
  return total
end

-- Read progress out of the carry string (currency-blind: we never see bet).
local function read_progress(prev)
  if not prev or prev == "" then return 0 end
  local ok, c = pcall(json.decode, prev)
  if not ok or type(c) ~= "table" then return 0 end
  local p = tonumber(c.progress)
  if not p or p < 0 then return 0 end
  return math.floor(p)
end

return {
  kind = "simple",
  name = "slots-meta",
  version = "1.0.0",
  rtp = RTP_BASE + RTP_BONUS,
  expected = {
    rtp_contribution = { base = { target = RTP_BASE, tolerance = 0.05 }, bonus = { target = RTP_BONUS, tolerance = 0.06 } },
  },

  play = function(prev, _ctx)
    local g = spin_grid()
    local base = evaluate_lines(g)
    local scatters = count_scatters(g)

    local progress = read_progress(prev)
    progress = progress + scatters

    host.mark.contribute("base", base)
    local total = base
    local bonus_paid = false

    -- Fire the bonus the moment we reach/cross the goal; reset progress. We
    -- subtract GOAL (rather than zeroing) so any overshoot from a multi-scatter
    -- spin carries forward — and we only pay ONCE per crossing.
    if progress >= GOAL then
      total = total + BONUS_PAY
      progress = progress - GOAL
      bonus_paid = true
      host.mark.contribute("bonus", BONUS_PAY)
      host.mark.tag("bonus")
    end

    -- Write progress back. lockedBet is ALWAYS nil from the math — the adapter
    -- owns the lock and re-derives it from this progress + the real bet.
    local carry = json.encode({ progress = progress, lockedBet = nil })

    local ops = {
      { kind = "slot", action = "spin", grid = g, base = base, scatters = scatters, progress = progress, goal = GOAL },
    }
    if bonus_paid then
      ops[#ops + 1] = { kind = "slot", action = "bonus", pay = BONUS_PAY }
    end

    return {
      multiplier = total,
      type = bonus_paid and "bonus" or (scatters > 0 and "progress") or (base > 0 and "win") or "loss",
      ops = ops,
      carry = carry,
    }
  end,
}
