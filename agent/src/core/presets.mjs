// Risk presets. Every number here maps 1:1 to QuorumVault.Policy (bps / seconds).

export const PRESETS = {
  conservative: {
    maxTradeBps: 500,
    maxPositionBps: 2500,
    maxSlippageBps: 50,
    maxDailyLossBps: 200,
    stopLossBps: 200,
    takeProfitBps: 400,
    maxTradesPerDay: 12,
    cooldown: 300,
    quorum: 3,
  },
  balanced: {
    // identical to the QuorumVault constructor defaults
    maxTradeBps: 2000,
    maxPositionBps: 5000,
    maxSlippageBps: 100,
    maxDailyLossBps: 500,
    stopLossBps: 300,
    takeProfitBps: 600,
    maxTradesPerDay: 48,
    cooldown: 60,
    quorum: 2,
  },
  aggressive: {
    maxTradeBps: 3000,
    maxPositionBps: 8000,
    maxSlippageBps: 150,
    maxDailyLossBps: 1000,
    stopLossBps: 500,
    takeProfitBps: 1200,
    maxTradesPerDay: 200,
    cooldown: 30,
    quorum: 2,
  },
};

export const POLICY_KEYS = [
  'maxTradeBps',
  'maxPositionBps',
  'maxSlippageBps',
  'maxDailyLossBps',
  'stopLossBps',
  'takeProfitBps',
  'maxTradesPerDay',
  'cooldown',
  'quorum',
];

/** Same rules as QuorumVault._setPolicy. Returns an error string or null. */
export function validatePolicy(p) {
  for (const k of POLICY_KEYS) {
    if (!Number.isInteger(p[k]) || p[k] < 0) return `${k} must be a non-negative integer`;
  }
  if (p.maxTradeBps === 0 || p.maxTradeBps > 10_000) return 'maxTradeBps must be 1..10000';
  if (p.maxPositionBps === 0 || p.maxPositionBps > 10_000) return 'maxPositionBps must be 1..10000';
  if (p.maxSlippageBps > 1000) return 'maxSlippageBps must be <= 1000';
  if (p.maxDailyLossBps === 0 || p.maxDailyLossBps > 10_000) return 'maxDailyLossBps must be 1..10000';
  if (p.stopLossBps === 0 || p.stopLossBps >= 10_000) return 'stopLossBps must be 1..9999';
  if (p.takeProfitBps === 0) return 'takeProfitBps must be > 0';
  if (p.maxTradesPerDay === 0 || p.maxTradesPerDay > 65_535) return 'maxTradesPerDay must be 1..65535';
  if (p.cooldown > 4_294_967_295) return 'cooldown too large';
  if (p.quorum === 0 || p.quorum > 3) return 'quorum must be 1..3';
  if (p.takeProfitBps > 65_535) return 'takeProfitBps must be <= 65535';
  return null;
}

export function presetName(p) {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (POLICY_KEYS.every((k) => preset[k] === p[k])) return name;
  }
  return 'custom';
}
