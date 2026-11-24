// Wires a fully simulated Quorum stack (market + vault + engine). Used by `npm run demo`,
// the tests and the standalone browser demo.

import { SimMarket, DEFAULT_ASSETS } from './simMarket.mjs';
import { SimVault } from './simVault.mjs';
import { QuorumEngine } from './engine.mjs';

export function simFeed(market) {
  return {
    symbols: () => market.symbols(),
    next: async () => market.step(),
    warmup: async (n) => Array.from({ length: n }, () => market.step()),
  };
}

/**
 * @param {{seed?:number, deposit?:number, intervalMs?:number, assets?:object[], llm?:object, log?:Function}} [opts]
 */
export async function createSimEngine(opts = {}) {
  const market = new SimMarket({ seed: opts.seed ?? 177, assets: opts.assets ?? DEFAULT_ASSETS, stepSeconds: 60 });
  const vault = new SimVault({ market, baseSymbol: 'USDT', deposit: opts.deposit ?? 10_000 });
  const engine = new QuorumEngine({
    vault,
    market: simFeed(market),
    llm: opts.llm ?? null,
    intervalMs: opts.intervalMs ?? 2500,
    minTrade: 5,
    attestHolds: true,
    log: opts.log,
  });
  await engine.init();
  return { engine, vault, market };
}
