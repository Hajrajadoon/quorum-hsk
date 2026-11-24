// Pure technical-analysis helpers. Input: array of numbers (oldest -> newest).

export function ema(values, period) {
  if (!values.length) return NaN;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function sma(values, period) {
  const s = values.slice(-period);
  if (!s.length) return NaN;
  return s.reduce((a, b) => a + b, 0) / s.length;
}

export function stdev(values) {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

export function logReturns(values) {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0 && values[i] > 0) out.push(Math.log(values[i] / values[i - 1]));
  }
  return out;
}

/** Wilder RSI */
export function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function zscore(values, period = 20) {
  const s = values.slice(-period);
  if (s.length < 3) return 0;
  const sd = stdev(s);
  if (sd === 0) return 0;
  return (s[s.length - 1] - sma(s, s.length)) / sd;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round = (x, d = 4) => {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

/**
 * Feature vector the council reasons about.
 * @param {{price:number, ref?:number}[]} history
 */
export function features(history) {
  const prices = history.map((h) => h.price);
  const n = prices.length;
  const last = prices[n - 1];
  const emaFast = ema(prices.slice(-60), 8);
  const emaSlow = ema(prices.slice(-90), 21);
  const rets = logReturns(prices.slice(-31));
  const vol = stdev(rets); // per-tick volatility
  const longVol = stdev(logReturns(prices.slice(-121))) || vol;
  const lookback = Math.min(10, n - 1);
  const momentum = lookback > 0 ? last / prices[n - 1 - lookback] - 1 : 0;
  const ref = history[n - 1]?.ref;
  const spreadBps = ref && last ? ((ref - last) / last) * 10_000 : 0;
  return {
    price: round(last, 8),
    emaFast: round(emaFast, 8),
    emaSlow: round(emaSlow, 8),
    emaGapPct: round(((emaFast - emaSlow) / emaSlow) * 100, 3),
    rsi: round(rsi(prices.slice(-60), 14), 2),
    zscore: round(zscore(prices, 20), 3),
    momentumPct: round(momentum * 100, 3),
    volPct: round(vol * 100, 4),
    volRatio: round(longVol > 0 ? vol / longVol : 1, 3),
    refPrice: ref ? round(ref, 8) : null,
    spreadBps: round(spreadBps, 1),
    samples: n,
  };
}
