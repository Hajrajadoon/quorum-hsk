#!/usr/bin/env node
// QUORUM agent entry point.
//   MODE=sim  -> fully simulated market + vault (no keys needed, perfect for rehearsals)
//   MODE=live -> real QuorumVault on HSK Chain
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, envJson } from './live/env.mjs';
import { createLLM } from './live/llm.mjs';
import { startServer } from './server.mjs';
import { createSimEngine } from './core/sim.mjs';
import { QuorumEngine } from './core/engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));

const env = process.env;
const argMode = process.argv.includes('--live') ? 'live' : process.argv.includes('--sim') ? 'sim' : null;
const MODE = (argMode || env.MODE || 'sim').toLowerCase();
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '127.0.0.1';
const DATA = path.join(ROOT, 'data');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function bool(v, d = false) {
  if (v === undefined || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
}

async function main() {
  const llm = createLLM({
    baseUrl: env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 15000),
    log,
  });
  log(llm ? `LLM council enabled (${llm.model})` : 'LLM not configured: council runs on deterministic quant models');

  let engine;
  if (MODE === 'sim') {
    const minInterval = llm ? 8000 : 500;
    ({ engine } = await createSimEngine({
      seed: Number(env.SIM_SEED || 1),
      deposit: Number(env.SIM_DEPOSIT || 10000),
      intervalMs: Math.max(minInterval, Number(env.LOOP_MS || 2500)),
      llm,
      log,
    }));
  } else if (MODE === 'live') {
    const { LiveVault, MockPricePusher } = await import('./live/chain.mjs');
    const { createLiveFeed } = await import('./live/feed.mjs');
    for (const k of ['RPC_URL', 'VAULT_ADDRESS', 'AGENT_PRIVATE_KEY']) {
      if (!env[k]) throw new Error(`${k} is required in live mode (see .env.example)`);
    }
    const vault = await LiveVault.connect({
      rpcUrl: env.RPC_URL,
      chainId: env.CHAIN_ID ? Number(env.CHAIN_ID) : undefined,
      vaultAddress: env.VAULT_ADDRESS,
      agentKey: env.AGENT_PRIVATE_KEY,
      explorer: env.EXPLORER_URL,
      probeAmount: Number(env.PRICE_PROBE || 1),
    });
    log(`Connected to ${vault.network} · vault ${vault.address} · base ${vault.base.symbol} · tokens ${Object.keys(vault.tokens).join(', ')}`);

    let pusher = null;
    if (env.MOCK_FEED_PRIVATE_KEY) {
      pusher = new MockPricePusher({ vault, key: env.MOCK_FEED_PRIVATE_KEY, minMove: Number(env.MOCK_FEED_MIN_MOVE || 0.002) });
      await pusher.check();
      log('Demo venue: simulated prices are pushed on-chain to the MockAdapter each tick');
    }

    fs.mkdirSync(DATA, { recursive: true });
    const histFile = path.join(DATA, `history-${vault.chainId}-${vault.address}.json`);
    let history = [];
    try {
      history = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    } catch {
      history = [];
    }
    const feed = createLiveFeed({ vault, refIds: envJson('REF_PRICE_IDS', {}), pusher, history, log });
    const baseNext = feed.next;
    feed.next = async () => {
      const step = await baseNext();
      history.push(step);
      if (history.length > 400) history.splice(0, history.length - 400);
      fs.writeFile(histFile, JSON.stringify(history), () => {});
      return step;
    };

    engine = new QuorumEngine({
      vault,
      market: feed,
      llm,
      intervalMs: Math.max(5000, Number(env.LOOP_MS || 30000)),
      minTrade: Number(env.MIN_TRADE || 1),
      attestHolds: bool(env.ATTEST_HOLDS, false),
      log,
    });
    await engine.init();
  } else {
    throw new Error(`MODE must be "sim" or "live", got "${MODE}"`);
  }

  // append-only audit log of every reasoning record (the preimages of the on-chain hashes)
  fs.mkdirSync(DATA, { recursive: true });
  const proofs = fs.createWriteStream(path.join(DATA, `proofs-${MODE}.jsonl`), { flags: 'a' });
  engine.subscribe((type, payload) => {
    if (type !== 'decision') return;
    const d = engine.getDecision(payload.id);
    if (d) proofs.write(JSON.stringify({ id: d.id, t: d.t, action: d.action, symbol: d.symbol, status: d.status, txHash: d.txHash, reasoningHash: d.reasoningHash, json: d.json }) + '\n');
    if (payload.action === 'BUY' || payload.action === 'SELL') {
      log(`#${payload.id} ${payload.action} ${payload.symbol} ${payload.status}${payload.txHash ? ' ' + payload.txHash : ''}${payload.error ? ' ' + payload.error : ''}`);
    }
  });

  await startServer(engine, { port: PORT, host: HOST, controlToken: env.CONTROL_TOKEN || undefined, log });
  engine.start();
  log(`QUORUM ${MODE.toUpperCase()} dashboard → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);

  const shutdown = () => {
    log('shutting down');
    engine.stop();
    proofs.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('\nQUORUM failed to start:', e?.message ?? e);
  process.exit(1);
});
