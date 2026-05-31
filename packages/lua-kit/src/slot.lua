-- slot.lua — the reel/payline boilerplate every slot rewrites, once and safe.
--
-- A slot's math is mostly the same three chores: draw weighted symbols onto a
-- grid, scan paylines left-to-right for runs (wilds substituting), and count
-- scatters. Getting those subtly wrong is where bugs and RTP drift hide. This
-- prelude does them once so a game author writes DATA (a weight table, a
-- paytable, a line list) and a few calls — not loops.
--
-- Injected as a chunk-local `slot` by @open-rgs-examples/lua-kit (a prelude, so
-- everything here operates on NATIVE Lua tables the math builds — no JS bridge,
-- no marshalling traps). Pure and deterministic given host.rng_next.
--
-- Design note (safety): this is a KIT, not a framework. It has no notion of
-- money, bet, carry, or the wallet — it can't, the math is currency-blind
-- (Guarantee 3). It returns dimensionless win contributions; the engine
-- multiplies by the bet. You cannot express an exploit in a weight table.

local slot = {}

-- ── weighted reels ──────────────────────────────────────────────────────────

-- Build a sampler from a { symbol = weight } table. Returns draw() → symbol,
-- using host.rng_next (the injected, auditable RNG). Precomputes the total once.
--   local draw = slot.reel({ A = 6, K = 8, SCAT = 3 })
--   local s = draw()
function slot.reel(weights)
  local syms, cum, total = {}, {}, 0
  -- Stable order: sort keys so the cumulative bands are deterministic across
  -- runs (pairs() order is unspecified in Lua; a sim must be reproducible).
  for sym in pairs(weights) do syms[#syms + 1] = sym end
  table.sort(syms)
  for _, sym in ipairs(syms) do total = total + weights[sym]; cum[#cum + 1] = total end
  return function()
    local r = host.rng_next() * total
    for i = 1, #syms do
      if r < cum[i] then return syms[i] end
    end
    return syms[#syms]
  end
end

-- Spin a `reels`×`rows` grid using a draw function. grid[reel][row], 1-indexed.
--   local g = slot.grid(draw, 5, 3)
function slot.grid(draw, reels, rows)
  local g = {}
  for reel = 1, reels do
    local col = {}
    for row = 1, rows do col[row] = draw() end
    g[reel] = col
  end
  return g
end

-- ── scatters ──────────────────────────────────────────────────────────────────

-- Count how many cells across the whole grid hold `symbol`.
function slot.count(grid, symbol)
  local n = 0
  for reel = 1, #grid do
    local col = grid[reel]
    for row = 1, #col do if col[row] == symbol then n = n + 1 end end
  end
  return n
end

-- ── paylines ──────────────────────────────────────────────────────────────────

-- Evaluate fixed paylines left-to-right and return the total win as a fraction
-- of TOTAL bet. Arguments:
--   grid      : grid[reel][row] from slot.grid
--   lines     : array of lines; each line is an array of row indices per reel
--               e.g. { {2,2,2,2,2}, {1,2,3,2,1} }
--   paytable  : { [symbol] = { [runLength] = payAsFractionOfTotalBet } }
--   opts      : { wild = "W", scatter = "SCAT", lineShare = 1/#lines }
--               wild substitutes for any pay symbol; scatter never pays a line.
--               lineShare scales each line's pay (default: split bet across lines).
-- Returns: total, details  (details = array of { line, sym, run, pay } for ops).
function slot.paylines(grid, lines, paytable, opts)
  opts = opts or {}
  local wild = opts.wild
  local scatter = opts.scatter
  local lineShare = opts.lineShare or (1.0 / #lines)
  local total = 0
  local details = {}

  for li = 1, #lines do
    local line = lines[li]
    -- Read the symbols along the line.
    local syms = {}
    for reel = 1, #line do syms[reel] = grid[reel][line[reel]] end

    -- The paying symbol is the first non-wild (so a leading wild adopts the
    -- next real symbol). An all-wild line pays as the wild itself.
    local pay_sym = syms[1]
    if wild and pay_sym == wild then
      for reel = 2, #syms do
        if syms[reel] ~= wild then pay_sym = syms[reel]; break end
      end
    end

    if pay_sym ~= scatter and paytable[pay_sym] then
      -- Count the leading run of (pay_sym or wild).
      local run = 0
      for reel = 1, #syms do
        local s = syms[reel]
        if s == pay_sym or (wild and s == wild) then run = run + 1 else break end
      end
      local pay = paytable[pay_sym][run]
      if pay then
        local won = pay * lineShare
        total = total + won
        details[#details + 1] = { line = li, sym = pay_sym, run = run, pay = won }
      end
    end
  end

  return total, details
end

return slot
