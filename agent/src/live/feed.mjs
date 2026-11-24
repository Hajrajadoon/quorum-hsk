// Live market feed: venue prices from the on-chain quoter, optional reference prices
// (CoinGecko) for spread / arbitrage detection, optional simulated price pusher for the demo venue.

import { SimMarket } from '../core/simMarket.mjs';

export function createLiveFeed({ vault, refIds = {}, pusher = null, history = [], log = () => {} }) {
  const symbols = Object.keys(vault.tokens);
  let refCache = { t: 0, prices: {} };
  let sim = null;

  async function refPrices() {
    const ids = Object.values(refIds).filter(Boolean);
    if (!ids.length) return {};
    if (Date.now() - refCache.t < 25_000) return refCache.prices;
    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`coingecko ${res.status}`);
      const data = await res.json();
      const prices = {};
      for (const [sym, id] of Object.entries(refIds)) if (data[id]?.usd) prices[sym] = data[id].usd;
      refCache = { t: Date.now(), prices };
    } catch (e) {
      log('reference price error:', e.message);
    }
    return refCache.prices;
  }

  return {
    symbols: () => symbols,
    async warmup() {
      // replay persisted history so indicators survive restarts
      return history;
    },
    async next() {
      const t = Math.floor(Date.now() / 1000);
      const quotes = {};
      if (pusher) {
        if (!sim) {
          // seed the simulated walk from the current on-chain venue prices
          const assets = [];
          for (const s of symbols) assets.push({ symbol: s, price: (await vault.price(s)) || 1, vol: 0.006 });
          sim = new SimMarket({ seed: Date.now() % 100000, assets, stepSeconds: 30, startTime: t });
        }
        const step = sim.step();
        const prices = {};
        for (const s of symbols) prices[s] = step.quotes[s].price;
        await pusher.pushAll(prices); // one transaction for every symbol that moved
        for (const s of symbols) quotes[s] = { price: step.quotes[s].price, ref: step.quotes[s].ref };
        return { t, quotes };
      }
      const refs = await refPrices();
      for (const s of symbols) {
        try {
          const price = await vault.price(s);
          quotes[s] = { price, ref: refs[s] ?? null };
        } catch (e) {
          log(`price error ${s}:`, e.shortMessage ?? e.message);
        }
      }
      return { t, quotes };
    },
  };
}
