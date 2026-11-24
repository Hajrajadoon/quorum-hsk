import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256Utf8, canonicalJson } from '../src/core/keccak.mjs';
import { PRESETS, validatePolicy, presetName } from '../src/core/presets.mjs';
import { SimMarket } from '../src/core/simMarket.mjs';
import { SimVault } from '../src/core/simVault.mjs';
import { tally, deliberate } from '../src/core/council.mjs';
import { parseIntent, resolveSymbol } from '../src/core/chat.mjs';
import { checkExits, precheckBuy, sizeBuy, agentSlippageBps } from '../src/core/risk.mjs';
import { createSimEngine } from '../src/core/sim.mjs';
import { extractJson } from '../src/live/llm.mjs';

test('keccak256 matches Ethereum vectors', () => {
  assert.equal(keccak256Utf8(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256Utf8('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256Utf8('transfer(address,uint256)').slice(0, 10), '0xa9059cbb');
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), canonicalJson({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
});

test('presets are valid and recognised', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.equal(validatePolicy(p), null, name);
    assert.equal(presetName(p), name);
  }
  assert.match(validatePolicy({ ...PRESETS.balanced, quorum: 4 }), /quorum/);
  assert.match(validatePolicy({ ...PRESETS.balanced, maxSlippageBps: 1001 }), /Slippage/i);
});

function vaultAt(price = 0.5) {
  const market = new SimMarket({ assets: [{ symbol: 'HSK', price, vol: 0 }], startTime: 1_000_000 });
  market.assets[0].dex = price;
  const vault = new SimVault({ market, deposit: 10_000, feeBps: 0 });
  return { market, vault };
}

test('sim vault enforces the same guardrails as the contract', async () => {
  const { market, vault } = vaultAt();
  const h = '0x' + '11'.repeat(32);
  await assert.rejects(vault.buy({ symbol: 'HSK', amountIn: 2_001, slippageBps: 50, reasoningHash: h, votes: 2 }), /TradeTooLarge/);
  await assert.rejects(vault.buy({ symbol: 'HSK', amountIn: 100, slippageBps: 50, reasoningHash: h, votes: 1 }), /QuorumNotMet/);
  await assert.rejects(vault.buy({ symbol: 'HSK', amountIn: 100, slippageBps: 200, reasoningHash: h, votes: 2 }), /SlippageTooWide/);
  const r = await vault.buy({ symbol: 'HSK', amountIn: 1_000, slippageBps: 50, reasoningHash: h, votes: 2 });
  assert.equal(r.amountOut, 2_000);
  await assert.rejects(vault.buy({ symbol: 'HSK', amountIn: 100, slippageBps: 50, reasoningHash: h, votes: 2 }), /CooldownActive/);
  market.time += 61;
  await vault.buy({ symbol: 'HSK', amountIn: 100, slippageBps: 50, reasoningHash: h, votes: 2 });
  const s = await vault.snapshot();
  assert.equal(s.buysToday, 2);
  assert.equal(s.totalCostBasis, 1_100);
});

test('sim vault circuit breaker halts buys but not sells', async () => {
  const { market, vault } = vaultAt();
  const h = '0x' + '22'.repeat(32);
  await vault.buy({ symbol: 'HSK', amountIn: 2_000, slippageBps: 50, reasoningHash: h, votes: 2 });
  market.assets[0].dex = 0.3;
  const r = await vault.sell({ symbol: 'HSK', amountIn: 3_000, slippageBps: 50, reasoningHash: h, votes: 2 });
  assert.ok(Math.abs(r.pnl + 600) < 1e-6);
  assert.equal((await vault.snapshot()).halted, true);
  await vault.sell({ symbol: 'HSK', amountIn: 1_000, slippageBps: 50, reasoningHash: h, votes: 2 });
  market.time += 120;
  await assert.rejects(vault.buy({ symbol: 'HSK', amountIn: 10, slippageBps: 50, reasoningHash: h, votes: 2 }), /BuysHalted/);
  market.time += 86_400;
  await vault.buy({ symbol: 'HSK', amountIn: 10, slippageBps: 50, reasoningHash: h, votes: 2 });
});

test('tally: quorum, veto and holding rules', () => {
  const v = (stance, extra = {}) => ({ name: stance, stance, confidence: 0.7, ...extra });
  assert.equal(tally([v('BUY'), v('BUY'), v('HOLD')], 2, false).action, 'BUY');
  assert.equal(tally([v('BUY'), v('BUY'), v('HOLD', { veto: true })], 2, false).action, 'VETO');
  assert.equal(tally([v('BUY'), v('BUY'), v('HOLD')], 3, false).action, 'HOLD');
  assert.equal(tally([v('SELL'), v('SELL'), v('HOLD')], 2, true).action, 'SELL');
  assert.equal(tally([v('SELL'), v('SELL'), v('HOLD')], 2, false).action, 'HOLD');
});

test('LLM cannot lift the hard veto, and falls back on bad output', async () => {
  const f = { price: 1, emaFast: 1.02, emaSlow: 1, emaGapPct: 2, rsi: 50, zscore: 0, momentumPct: 1, volPct: 2, volRatio: 2.5, refPrice: 1, spreadBps: 0, samples: 100 };
  const ctx = { symbol: 'HSK', f, holding: false, pnlPct: 0, exposurePct: 0, policy: PRESETS.balanced, dailyLossUsedPct: 0, halted: false };
  const llm = { json: async () => ({ stance: 'BUY', confidence: 0.99, rationale: 'YOLO' }) };
  const votes = await deliberate(ctx, { llm });
  const sentinel = votes.find((x) => x.id === 'sentinel');
  assert.equal(sentinel.veto, true);
  assert.notEqual(sentinel.stance, 'BUY');
  assert.equal(tally(votes, 2, false).action, 'VETO');

  const broken = { json: async () => ({ stance: 'MOON' }) };
  const votes2 = await deliberate(ctx, { llm: broken });
  assert.ok(votes2.every((x) => x.source === 'rules'));
});

test('chat intents', () => {
  const S = ['HSK', 'WETH'];
  assert.equal(resolveSymbol('eth', S), 'WETH');
  assert.equal(resolveSymbol('whsk', S), 'HSK');
  const cases = {
    'be more conservative': ['preset', { name: 'conservative' }],
    'go aggressive': ['preset', { name: 'aggressive' }],
    'stop loss 2.5%': ['setParam', { key: 'stopLossBps', value: 250 }],
    'take profit 8%': ['setParam', { key: 'takeProfitBps', value: 800 }],
    'max trade size 10%': ['setParam', { key: 'maxTradeBps', value: 1000 }],
    'max position 30%': ['setParam', { key: 'maxPositionBps', value: 3000 }],
    'trade every 5 minutes': ['setParam', { key: 'cooldown', value: 300 }],
    'max 20 trades per day': ['setParam', { key: 'maxTradesPerDay', value: 20 }],
    'unanimous votes only': ['setParam', { key: 'quorum', value: 3 }],
    'only trade HSK': ['targets', { mode: 'only', symbols: ['HSK'] }],
    'add eth': ['targets', { mode: 'add', symbols: ['WETH'] }],
    'close all': ['closeAll', undefined],
    'sell HSK': ['close', { symbol: 'HSK' }],
    'pause': ['pause', undefined],
    'stop trading': ['pause', undefined],
    'resume': ['resume', undefined],
    'why did you buy?': ['why', undefined],
    "what's my pnl": ['status', undefined],
    'analyze eth': ['analyze', { symbol: 'WETH' }],
    'trade smaller': ['sizeMult', { factor: 0.5 }],
  };
  for (const [text, [intent, args]] of Object.entries(cases)) {
    const r = parseIntent(text, S);
    assert.equal(r.intent, intent, text);
    if (args) assert.deepEqual(r.args, args, text);
  }
});

test('risk helpers mirror the contract', () => {
  const policy = PRESETS.balanced;
  const snap = { baseBalance: 10_000, totalCostBasis: 0, paused: false, halted: false, lastBuyAt: 0, buysToday: 0 };
  const s = sizeBuy({ snap, policy, prefs: { sizeMultiplier: 1 }, confidence: 1, positionCost: 0 });
  assert.ok(s.amount <= 2_000 && s.amount > 1_900);
  assert.equal(precheckBuy({ snap, policy, now: 100, amountIn: s.amount, positionCost: 0, minTrade: 5 }), null);
  assert.equal(precheckBuy({ snap: { ...snap, lastBuyAt: 90 }, policy, now: 100, amountIn: 10, positionCost: 0, minTrade: 5 }).code, 'CooldownActive');
  assert.equal(precheckBuy({ snap, policy, now: 100, amountIn: 2_001, positionCost: 0, minTrade: 5 }).code, 'TradeTooLarge');
  assert.equal(checkExits([{ symbol: 'HSK', balance: 1, cost: 100, pnlPct: -3.1 }], policy).reason, 'STOP_LOSS');
  assert.equal(checkExits([{ symbol: 'HSK', balance: 1, cost: 100, pnlPct: 6.2 }], policy).reason, 'TAKE_PROFIT');
  assert.equal(checkExits([{ symbol: 'HSK', balance: 1, cost: 100, pnlPct: 1 }], policy), null);
  assert.ok(agentSlippageBps(policy) < policy.maxSlippageBps);
});

test('extractJson handles fenced model output', () => {
  assert.deepEqual(extractJson('```json\n{"stance":"HOLD","confidence":0.5}\n```'), { stance: 'HOLD', confidence: 0.5 });
  assert.throws(() => extractJson('no json here'));
});

test('engine end-to-end: trades, proofs verify, chat controls policy', async () => {
  const { engine } = await createSimEngine({ seed: 1 });
  for (let i = 0; i < 300; i++) await engine.tick();
  const st = engine.publicState();
  assert.ok(engine.stats.trades > 0, 'should trade');
  assert.equal(engine.stats.ticks, 300);
  assert.equal(st.lastError, null);

  // every stored decision re-hashes to its committed hash
  for (const d of engine.decisions) {
    const full = engine.getDecision(d.id);
    assert.equal(keccak256Utf8(full.json), full.reasoningHash);
  }
  // a trade's reasoning stays verifiable
  const t = engine.trades[0];
  assert.equal(keccak256Utf8(engine.getDecision(t.id).json), t.reasoningHash);

  // the vault never breaks its own rules
  const snap = await engine.vault.snapshot();
  assert.ok(snap.baseBalance >= 0);
  assert.ok(snap.buysToday <= st.policy.maxTradesPerDay);

  const r = await engine.handleChat('be more conservative');
  assert.match(r.reply, /Policy updated/);
  assert.equal(engine.live.policy.quorum, 3);
  const r2 = await engine.handleChat('close all');
  assert.match(r2.reply, /Closed|Nothing to close/);
  assert.ok(engine.live.views.every((v) => v.balance === 0));
  const r3 = await engine.handleChat('stop loss 0%');
  assert.match(r3.reply, /Rejected/);
});
