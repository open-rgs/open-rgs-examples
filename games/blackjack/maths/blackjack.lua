-- blackjack.lua — the odd one out, on purpose.
--
-- Every other game here is built so its RTP is a fixed number, independent of
-- how the player plays. Blackjack is NOT: its return depends entirely on the
-- DECISIONS the player makes. Play the reference "basic strategy" and the RTP
-- is ~0.974 (declared below, and verified by the simulator); hit until you
-- bust and it's far worse. That makes it the example for *strategy testing*: a
-- generic simulator that picks arbitrary actions measures garbage, so you must
-- drive it with the reference strategy and prove no other strategy beats it
-- (see docs/math-testing.md and `bun run sim --game blackjack --compare`).
--
-- Rules: infinite deck (cards drawn with replacement), dealer stands on all 17
-- (S17), blackjack pays 3:2, hit/stand only. Double and split are intentionally
-- omitted — they require taking a SECOND wager mid-round, which the single
-- open→close money flow of a complex round doesn't model (you'd open the extra
-- stake as its own transaction). That omission is itself a useful lesson.
--
-- multiplier = total returned to the player: lose 0, push 1, win 2, blackjack 2.5.
-- `json` is injected by the lua-kit prelude.

-- RTP under basic strategy, as measured by `bun run sim --game blackjack
-- --strategy basic` (≈97.4% over 1M hands, CI ±0.2%). Hit/stand-only sits well
-- below the famous ~99.5% of full basic strategy — doubling and splitting are
-- worth that ~2%, and we omit them (see the note above).
local RTP = 0.974

-- Draw a card value from an infinite deck: A=11, 2–9 face, 10/J/Q/K = 10.
-- P(10-value) = 4/13, everything else 1/13.
local function draw()
  local r = math.floor(host.rng_next() * 13) + 1   -- 1..13
  if r == 1 then return 11 end
  if r >= 10 then return 10 end
  return r
end

-- Best total for a hand, downgrading aces from 11→1 as needed. Returns
-- (total, soft) where soft means an ace is still counted as 11.
local function hand_value(cards)
  local total, aces = 0, 0
  for _, v in ipairs(cards) do
    total = total + v
    if v == 11 then aces = aces + 1 end
  end
  while total > 21 and aces > 0 do total = total - 10; aces = aces - 1 end
  return total, aces > 0
end

return {
  kind = "complex",
  name = "blackjack",
  version = "1.0.0",
  rtp = RTP,
  -- No `expected` block: hit-rate / contributions are only meaningful for a
  -- specific strategy, and the built-in simulator doesn't play one. Strategy
  -- testing lives in the sim tool (--strategy / --compare).

  open = function(_prev, _ctx)
    local player = { draw(), draw() }
    local dealer = { draw() }                 -- upcard; hole is drawn at close
    local total = hand_value(player)
    local awaiting = nil
    if total < 21 then
      awaiting = { type = "act", options = { "stand", "hit" }, prompt = "Hit or stand? (you have " .. total .. ")" }
    end
    return {
      state = json.encode({ player = player, dealer = dealer, stood = false }),
      ops = { { kind = "blackjack", action = "deal", player = player, dealer_up = dealer[1], total = total } },
      awaiting = awaiting,
    }
  end,

  step = function(state_str, action)
    local s = json.decode(state_str)
    local total = hand_value(s.player)
    if s.stood or total >= 21 then
      return { state = state_str, ops = {}, awaiting = nil }
    end

    local move = tostring(action.value or "")
    if move == "hit" then
      local card = draw()
      s.player[#s.player + 1] = card
      local nt, soft = hand_value(s.player)
      local awaiting = nil
      if nt < 21 then
        awaiting = { type = "act", options = { "stand", "hit" },
                     prompt = "Hit or stand? (you have " .. nt .. (soft and " soft" or "") .. ")" }
      end
      return {
        state = json.encode(s),
        ops = { { kind = "blackjack", action = "hit", card = card, total = nt, bust = nt > 21 } },
        awaiting = awaiting,
      }
    elseif move == "stand" then
      s.stood = true
      return {
        state = json.encode(s),
        ops = { { kind = "blackjack", action = "stand", total = total } },
      }
    end
    -- unknown action: re-offer
    return { state = state_str, ops = {}, awaiting = { type = "act", options = { "stand", "hit" }, prompt = "Hit or stand?" } }
  end,

  is_terminal = function(state_str)
    local s = json.decode(state_str)
    local total = hand_value(s.player)
    return s.stood or total >= 21
  end,

  close = function(state_str)
    local s = json.decode(state_str)
    local pt = hand_value(s.player)
    local player_natural = (#s.player == 2 and pt == 21)

    if pt > 21 then
      host.mark.tag("bust")
      return { multiplier = 0, type = "bust",
               ops = { { kind = "blackjack", action = "settle", result = "bust", player = pt } } }
    end

    -- Dealer reveals the hole card, then hits to 17 (stands on all 17).
    local dealer = s.dealer
    dealer[#dealer + 1] = draw()
    local dealer_natural = (hand_value(dealer) == 21)   -- exactly two cards here

    local mult, result
    if player_natural and dealer_natural then
      mult, result = 1.0, "push"
    elseif player_natural then
      mult, result = 2.5, "blackjack"
    elseif dealer_natural then
      mult, result = 0.0, "dealer-blackjack"
    else
      local dt = hand_value(dealer)
      while dt < 17 do
        dealer[#dealer + 1] = draw()
        dt = hand_value(dealer)
      end
      if dt > 21 then mult, result = 2.0, "dealer-bust"
      elseif pt > dt then mult, result = 2.0, "win"
      elseif pt == dt then mult, result = 1.0, "push"
      else mult, result = 0.0, "lose" end
    end

    host.mark.tag(result)
    if mult > 0 then host.mark.contribute("payout", mult) end
    return {
      multiplier = mult,
      type = result,
      ops = { { kind = "blackjack", action = "settle", result = result,
                player = pt, dealer = hand_value(dealer), dealer_cards = dealer } },
    }
  end,
}
