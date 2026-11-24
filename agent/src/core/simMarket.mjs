// Deterministic market simulator: regime-switching random walk for the "true" (reference) price,
// plus a DEX price that drifts away from it and snaps back -> real spread / arbitrage signals.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const REGIMES = {
  bull: { drift: 0.0009, volMult: 1.0 },
  bear: { drift: -0.0009, volMult: 1.15 },
  chop: { drift: 0, volMult: 0.8 },
  storm: { drift: -0.0004, volMult: 2.6 },
};

export const DEFAULT_ASSETS = [
  { symbol: 'HSK', name: 'HashKey Token', price: 0.5, vol: 0.006 },
  { symbol: 'WETH', name: 'Wrapped Ether', price: 3000, vol: 0.004 },
];

export class SimMarket {
  /**
   * @param {{seed?:number, assets?:{symbol:string,name?:string,price:number,vol:number}[], stepSeconds?:number, startTime?:number}} opts
   */
  constructor(opts = {}) {
    this.rand = mulberry32(opts.seed ?? 177);
    this.stepSeconds = opts.stepSeconds ?? 60;
    this.time = opts.startTime ?? Math.floor(Date.now() / 1000);
    this.assets = (opts.assets ?? DEFAULT_ASSETS).map((a) => ({
      ...a,
      ref: a.price,
      dex: a.price,
      dislocation: 0,
      regime: 'chop',
      regimeLeft: 30,
    }));
  }

  symbols() {
    return this.assets.map((a) => a.symbol);
  }

  /** Advance one step. Returns { t, quotes: { SYMBOL: { price, ref } } } */
  step() {
    this.time += this.stepSeconds;
    const quotes = {};
    for (const a of this.assets) {
      if (--a.regimeLeft <= 0) {
        const r = this.rand();
        a.regime = r < 0.34 ? 'bull' : r < 0.64 ? 'bear' : r < 0.93 ? 'chop' : 'storm';
        a.regimeLeft = 20 + Math.floor(this.rand() * 60);
      }
      const reg = REGIMES[a.regime];
      const shock = gaussian(this.rand) * a.vol * reg.volMult;
      a.ref = a.ref * Math.exp(reg.drift + shock);
      // DEX dislocation: mean-reverting, with occasional jumps (thin liquidity / big orders)
      a.dislocation = a.dislocation * 0.82 + gaussian(this.rand) * 0.0007;
      if (this.rand() < 0.035) a.dislocation += (this.rand() < 0.5 ? -1 : 1) * (0.006 + this.rand() * 0.012);
      a.dex = a.ref * (1 + a.dislocation);
      quotes[a.symbol] = { price: a.dex, ref: a.ref, regime: a.regime };
    }
    return { t: this.time, quotes };
  }

  price(symbol) {
    const a = this.assets.find((x) => x.symbol === symbol);
    return a ? a.dex : NaN;
  }
}
