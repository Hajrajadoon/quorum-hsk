// Off-chain risk engine. It mirrors the on-chain QuorumVault rules so the agent never sends a
// transaction the contract would reject, and it runs the stop-loss / take-profit exits.

import { round } from './indicators.mjs';

/** Enrich raw positions with live prices. */
export function positionViews(positions, prices) {
  return positions.map((p) => {
    const price = prices[p.symbol] ?? 0;
    const value = p.balance * price;
    const pnl = value - p.cost;
    const pnlPct = p.cost > 0 ? (value / p.cost - 1) * 100 : 0;
    return { ...p, price, value, pnl, pnlPct };
  });
}

/** First position that hit its stop-loss or take-profit, or null. */
export function checkExits(views, policy) {
  const sl = policy.stopLossBps / 100;
  const tp = policy.takeProfitBps / 100;
  for (const v of views) {
    if (v.balance <= 0 || v.cost <= 0) continue;
    if (v.pnlPct <= -sl) return { symbol: v.symbol, reason: 'STOP_LOSS', pnlPct: round(v.pnlPct, 2), threshold: -sl };
    if (v.pnlPct >= tp) return { symbol: v.symbol, reason: 'TAKE_PROFIT', pnlPct: round(v.pnlPct, 2), threshold: tp };
  }
  return null;
}

/**
 * How much base to spend on a buy. Scales with confidence and the user's size preference,
 * then is clipped to every on-chain cap (with a small safety margin).
 */
export function sizeBuy({ snap, policy, prefs, confidence, positionCost }) {
  const equity = snap.baseBalance + snap.totalCostBasis;
  const maxTrade = (snap.baseBalance * policy.maxTradeBps) / 10_000;
  const positionRoom = (equity * policy.maxPositionBps) / 10_000 - positionCost;
  const wanted = maxTrade * clamp01(prefs.sizeMultiplier) * (0.5 + 0.5 * clamp01(confidence));
  const amount = Math.min(wanted, maxTrade * 0.995, positionRoom * 0.995);
  return { amount: Math.max(0, round(amount, 6)), maxTrade, positionRoom, equity };
}

/** Mirrors QuorumVault.buy() checks. Returns null when OK, otherwise { code, message }. */
export function precheckBuy({ snap, policy, now, amountIn, positionCost, minTrade }) {
  if (snap.paused) return { code: 'VaultPaused', message: 'owner kill switch is on' };
  if (snap.halted) return { code: 'BuysHalted', message: 'daily-loss circuit breaker is active until next UTC day' };
  if (snap.lastBuyAt && now < snap.lastBuyAt + policy.cooldown) {
    return { code: 'CooldownActive', message: `cooldown: ${snap.lastBuyAt + policy.cooldown - now}s left` };
  }
  if (snap.buysToday >= policy.maxTradesPerDay) {
    return { code: 'DailyTradeLimit', message: `max ${policy.maxTradesPerDay} buys per day reached` };
  }
  if (amountIn < minTrade) return { code: 'TooSmall', message: `size ${round(amountIn, 2)} below minimum ${minTrade}` };
  const equity = snap.baseBalance + snap.totalCostBasis;
  if (amountIn * 10_000 > policy.maxTradeBps * snap.baseBalance) {
    return { code: 'TradeTooLarge', message: `exceeds ${policy.maxTradeBps / 100}% per-trade cap` };
  }
  if ((positionCost + amountIn) * 10_000 > policy.maxPositionBps * equity) {
    return { code: 'PositionTooLarge', message: `exceeds ${policy.maxPositionBps / 100}% position cap` };
  }
  return null;
}

/** Slippage tolerance the agent uses: 80% of the on-chain maximum, so minOut always passes. */
export function agentSlippageBps(policy) {
  if (policy.maxSlippageBps === 0) return 0;
  return Math.max(1, Math.floor(policy.maxSlippageBps * 0.8));
}

function clamp01(x) {
  return Math.min(1, Math.max(0, Number(x) || 0));
}
