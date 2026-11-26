// QuorumEngine: market -> features -> council debate -> guardrails -> on-chain execution ->
// proof-of-reasoning. Environment-agnostic: runs in Node (live or sim) and in the browser (demo).

import { features, round, clamp } from './indicators.mjs';
import { deliberate, tally, COUNCIL } from './council.mjs';
import { positionViews, checkExits, sizeBuy, precheckBuy, agentSlippageBps } from './risk.mjs';
import { parseIntent, HELP_TEXT, INTENT_SCHEMA_FOR_LLM, resolveSymbol } from './chat.mjs';
import { PRESETS, presetName, validatePolicy } from './presets.mjs';
import { keccak256Utf8, canonicalJson } from './keccak.mjs';

export const ACTION_CODE = { HOLD: 0, BUY: 1, SELL: 2, VETO: 3, BLOCKED: 4 };
const WARMUP = 25;

export class QuorumEngine {
  /**
   * @param {object} o
   * @param {object} o.vault   SimVault or LiveVault (same interface)
   * @param {object} o.market  feed: { symbols(), next(), warmup?(n) }
   * @param {object} [o.llm]   { json(messages, opts) } or null
   * @param {number} [o.intervalMs]
   * @param {number} [o.minTrade] minimum trade size in base units
   * @param {boolean} [o.attestHolds] commit HOLD/VETO decisions on-chain too
   */
  constructor(o) {
    this.vault = o.vault;
    this.market = o.market;
    this.llm = o.llm ?? null;
    this.mode = o.vault.mode ?? 'sim';
    this.intervalMs = o.intervalMs ?? 2500;
    // while the council is still collecting its first WARMUP prices, tick faster (live mode)
    this.warmupIntervalMs = o.warmupIntervalMs ?? null;
    this.minTrade = o.minTrade ?? 5;
    this.attestHolds = o.attestHolds ?? this.mode === 'sim';
    this.historyLimit = o.historyLimit ?? 400;
    this.log = o.log ?? (() => {});
    this.history = {};
    this.decisions = [];
    this.archive = new Map(); // id -> decision, keeps trade reasoning verifiable for longer
    this.trades = [];
    this.chat = [];
    this.equityCurve = [];
    this.listeners = new Set();
    this.prefs = { sizeMultiplier: 1, targets: [], autoTrade: true };
    this.stats = { ticks: 0, decisions: 0, trades: 0, vetoes: 0, blocked: 0, proofs: 0 };
    this.seq = 0;
    this.cursor = 0;
    this.now = 0;
    this.busy = false;
    this.thinking = null;
    this.lastError = null;
    this.timer = null;
    this.running = false;
    this.feedHoldUntil = 0;
  }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    this.info = await this.vault.info();
    this.symbols = this.info.symbols;
    this.prefs.targets = [...this.symbols];
    for (const s of this.symbols) this.history[s] = [];
    if (this.market.warmup) {
      const steps = await this.market.warmup(150);
      for (const st of steps) this._pushQuotes(st);
    }
    await this._refresh();
    this.initialEquity = this.live.equity;
    this.chat.push({
      role: 'agent',
      t: this.now,
      text:
        `Council in session on ${this.info.network}. Atlas (momentum), Nyx (contrarian/arbitrage) and ` +
        `Sentinel (risk, veto) will debate every move. Ask me anything, or type "help".`,
    });
    return this;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) this.timer = setTimeout(loop, this.warmingUp() && this.warmupIntervalMs ? this.warmupIntervalMs : this.intervalMs);
    };
    this.timer = setTimeout(loop, 300);
  }

  /** true while any symbol has fewer than WARMUP prices (the council can't debate yet) */
  warmingUp() {
    return (this.symbols ?? []).some((s) => (this.history[s]?.length ?? 0) < WARMUP);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this.listeners) {
      try {
        fn(type, payload);
      } catch (e) {
        this.log('listener error', e);
      }
    }
  }

  _emitState() {
    this._emit('state', this.publicState());
  }

  // ------------------------------------------------------------------ main loop

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const md = await this.market.next();
      this._pushQuotes(md);
      await this._refresh();
      this.stats.ticks += 1;
      this.lastError = null;

      const { snap } = this.live;
      if (this.prefs.autoTrade && !snap.paused) {
        const exit = checkExits(this.live.views, this.live.policy);
        if (exit) {
          await this._exitPosition(exit.symbol, exit.reason, exit);
        } else {
          const sym = this._nextTarget();
          if (sym) await this.runCouncil(sym, { execute: true });
        }
        await this._refresh();
      }
    } catch (e) {
      this.lastError = e?.message ?? String(e);
      this.log('tick error:', this.lastError);
    } finally {
      this.thinking = null;
      this.busy = false;
      this._emitState();
    }
  }

  _pushQuotes(md) {
    this.now = md.t;
    for (const [sym, q] of Object.entries(md.quotes)) {
      if (!this.history[sym]) this.history[sym] = [];
      if (!(q.price > 0)) continue;
      const h = this.history[sym];
      h.push({ t: md.t, price: q.price, ref: q.ref ?? null });
      if (h.length > this.historyLimit) h.splice(0, h.length - this.historyLimit);
    }
  }

  _prices() {
    const out = {};
    for (const s of this.symbols) {
      const h = this.history[s];
      out[s] = h?.length ? h[h.length - 1].price : 0;
    }
    return out;
  }

  async _refresh() {
    const [snap, policy, positions] = await Promise.all([this.vault.snapshot(), this.vault.policy(), this.vault.positions()]);
    const views = positionViews(positions, this._prices());
    const marked = views.reduce((a, v) => a + v.value, 0);
    const unrealized = views.reduce((a, v) => a + v.pnl, 0);
    const equity = snap.baseBalance + marked;
    this.live = { snap, policy, views, equity, unrealized };
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || last.t !== this.now) {
      this.equityCurve.push({ t: this.now, equity: round(equity, 4) });
      if (this.equityCurve.length > this.historyLimit) this.equityCurve.shift();
    }
  }

  _nextTarget() {
    const targets = this.prefs.targets.filter((s) => this.symbols.includes(s));
    if (!targets.length) return null;
    this.cursor = (this.cursor + 1) % targets.length;
    return targets[this.cursor];
  }

  _view(symbol) {
    return this.live.views.find((v) => v.symbol === symbol) ?? { symbol, balance: 0, cost: 0, value: 0, pnl: 0, pnlPct: 0 };
  }

  _isHolding(view) {
    return view.balance > 0 && view.value >= Math.max(this.minTrade * 0.2, 1e-9);
  }

  // ------------------------------------------------------------------ the council

  /**
   * Run a council round for one asset.
   * @param {string} symbol
   * @param {{execute:boolean}} opts execute=false -> analysis only (nothing stored or sent)
   */
  async runCouncil(symbol, { execute }) {
    const hist = this.history[symbol] ?? [];
    if (hist.length < WARMUP) return null;
    const { snap, policy } = this.live;
    const f = features(hist);
    const view = this._view(symbol);
    const holding = this._isHolding(view);
    const equityAtCost = snap.baseBalance + snap.totalCostBasis;
    const lossLimit = (snap.dayStartEquity * policy.maxDailyLossBps) / 10_000;
    const ctx = {
      symbol,
      f,
      holding,
      pnlPct: view.pnlPct,
      exposurePct: equityAtCost > 0 ? (view.cost / equityAtCost) * 100 : 0,
      policy,
      dailyLossUsedPct: lossLimit > 0 ? (snap.realizedLossToday / lossLimit) * 100 : 0,
      halted: snap.halted,
    };

    if (execute) {
      this.thinking = { symbol, t: this.now };
      this._emit('thinking', this.thinking);
    }
    const votes = await deliberate(ctx, { llm: this.llm });
    const verdict = tally(votes, policy.quorum, holding);

    const decision = {
      id: 0,
      t: this.now,
      symbol,
      intent: verdict.action,
      action: verdict.action,
      votes: verdict.votes,
      quorum: policy.quorum,
      confidence: verdict.confidence,
      summary: verdict.summary,
      agents: votes,
      features: f,
      price: f.price,
      trigger: 'COUNCIL',
      sizing: null,
      guardrail: null,
      status: 'decided',
    };
    if (!execute) return decision;

    if (verdict.action === 'BUY') {
      const s = sizeBuy({ snap, policy, prefs: this.prefs, confidence: verdict.confidence, positionCost: view.cost });
      const guard = precheckBuy({ snap, policy, now: this.now, amountIn: s.amount, positionCost: view.cost, minTrade: this.minTrade });
      if (guard) {
        decision.action = 'BLOCKED';
        decision.guardrail = guard;
        decision.summary = `${verdict.summary} Guardrail blocked it: ${guard.message}.`;
      } else {
        decision.sizing = { side: 'buy', amountIn: s.amount, slippageBps: agentSlippageBps(policy), unit: this.info.baseSymbol };
      }
    } else if (verdict.action === 'SELL') {
      const fraction = verdict.confidence >= 0.7 ? 1 : 0.5;
      decision.sizing = { side: 'sell', amountIn: view.balance * fraction, fraction, slippageBps: agentSlippageBps(policy), unit: symbol };
    }
    return this._commit(decision);
  }

  /** Stop-loss / take-profit / user-requested exit: pre-authorized by the owner's policy. */
  async _exitPosition(symbol, reason, detail = {}) {
    const view = this._view(symbol);
    if (!(view.balance > 0)) return null;
    const { policy } = this.live;
    const why =
      reason === 'STOP_LOSS'
        ? `Stop-loss hit: ${detail.pnlPct}% <= ${detail.threshold}%. Exiting per the owner's on-chain policy.`
        : reason === 'TAKE_PROFIT'
          ? `Take-profit hit: +${detail.pnlPct}% >= ${detail.threshold}%. Locking in gains per policy.`
          : 'Owner instructed an exit from the chat. Executing.';
    const agents = COUNCIL.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      color: m.color,
      stance: 'SELL',
      confidence: 1,
      rationale: m.id === 'sentinel' ? why : 'Concur: exits pre-authorized by the owner are executed without debate.',
      source: 'policy',
      veto: false,
    }));
    const hist = this.history[symbol];
    const f = hist?.length >= 3 ? features(hist) : { price: view.price };
    const decision = {
      id: 0,
      t: this.now,
      symbol,
      intent: 'SELL',
      action: 'SELL',
      votes: 3,
      quorum: policy.quorum,
      confidence: 1,
      summary: why,
      agents,
      features: f,
      price: view.price,
      trigger: reason,
      sizing: { side: 'sell', amountIn: view.balance, fraction: 1, slippageBps: agentSlippageBps(policy), unit: symbol },
      guardrail: null,
      status: 'decided',
    };
    return this._commit(decision);
  }

  /** Hash the reasoning, send it on-chain with the trade (or as an attestation), store it. */
  async _commit(decision) {
    decision.id = ++this.seq;
    const record = {
      protocol: 'QUORUM/1',
      chainId: this.info.chainId,
      vault: this.info.vault,
      decisionId: decision.id,
      t: decision.t,
      symbol: decision.symbol,
      action: decision.action,
      intent: decision.intent,
      trigger: decision.trigger,
      quorum: decision.quorum,
      votes: decision.votes,
      price: decision.price,
      features: decision.features,
      agents: decision.agents.map((a) => ({
        name: a.name,
        role: a.role,
        stance: a.stance,
        confidence: a.confidence,
        rationale: a.rationale,
        veto: !!a.veto,
        source: a.source,
      })),
      sizing: decision.sizing,
      guardrail: decision.guardrail,
      policy: this.live.policy,
    };
    decision.json = canonicalJson(record);
    decision.reasoningHash = keccak256Utf8(decision.json);

    try {
      if (decision.action === 'BUY' || decision.action === 'SELL') {
        const args = {
          symbol: decision.symbol,
          amountIn: decision.sizing.amountIn,
          slippageBps: decision.sizing.slippageBps,
          reasoningHash: decision.reasoningHash,
          votes: decision.votes,
        };
        const res = decision.action === 'BUY' ? await this.vault.buy(args) : await this.vault.sell(args);
        decision.status = 'executed';
        decision.txHash = res.txHash;
        decision.result = { amountOut: res.amountOut, expectedOut: res.expectedOut, pnl: res.pnl };
        this.stats.trades += 1;
        this.trades.unshift({
          id: decision.id,
          t: decision.t,
          symbol: decision.symbol,
          side: decision.action,
          amountIn: decision.sizing.amountIn,
          amountOut: res.amountOut,
          price: decision.price,
          pnl: res.pnl,
          trigger: decision.trigger,
          txHash: res.txHash,
          reasoningHash: decision.reasoningHash,
        });
        if (this.trades.length > 100) this.trades.pop();
        this.stats.proofs += 1;
        this._emit('trade', this.trades[0]);
      } else if (this.attestHolds) {
        const res = await this.vault.attest(decision.reasoningHash, ACTION_CODE[decision.action], decision.votes);
        decision.status = 'attested';
        decision.txHash = res.txHash;
        this.stats.proofs += 1;
      } else {
        decision.status = 'logged';
      }
    } catch (e) {
      decision.status = 'rejected';
      decision.error = e?.code ?? e?.shortMessage ?? e?.message ?? String(e);
      this.log(`decision #${decision.id} rejected:`, decision.error);
    }

    if (decision.action === 'VETO') this.stats.vetoes += 1;
    if (decision.action === 'BLOCKED') this.stats.blocked += 1;
    this.stats.decisions += 1;
    this.decisions.unshift(decision);
    if (this.decisions.length > 120) this.decisions.pop();
    this.archive.set(decision.id, decision);
    if (this.archive.size > 400) {
      // drop the oldest non-trade decision first, then the oldest of anything
      let drop = null;
      for (const [k, v] of this.archive) {
        if (v.status !== 'executed') {
          drop = k;
          break;
        }
      }
      this.archive.delete(drop ?? this.archive.keys().next().value);
    }
    this._emit('decision', this._decisionSummary(decision));
    return decision;
  }

  // ------------------------------------------------------------------ chat

  async handleChat(text) {
    const msg = String(text ?? '').slice(0, 500);
    this.chat.push({ role: 'user', t: this.now, text: msg });
    let intent = parseIntent(msg, this.symbols);
    if (intent.intent === 'unknown' && this.llm) {
      try {
        const out = await this.llm.json(
          [
            { role: 'system', content: `${INTENT_SCHEMA_FOR_LLM}\nKnown assets: ${this.symbols.join(', ')}. Context: ${this._statusLine()}` },
            { role: 'user', content: msg },
          ],
          { maxTokens: 200 },
        );
        if (out && typeof out.intent === 'string') intent = out;
      } catch (e) {
        this.log('llm intent error', e?.message);
      }
    }
    let result;
    try {
      result = await this._applyIntent(intent);
    } catch (e) {
      result = { reply: `That didn't work: ${e?.message ?? e}` };
    }
    this.chat.push({ role: 'agent', t: this.now, text: result.reply, ownerTx: result.ownerTx ?? null });
    if (this.chat.length > 80) this.chat.splice(0, this.chat.length - 80);
    this._emitState();
    return result;
  }

  async _applyIntent({ intent, args = {} }) {
    const { policy } = this.live;
    switch (intent) {
      case 'help':
        return { reply: HELP_TEXT };
      case 'status':
        return { reply: this._statusText() };
      case 'policy':
        return { reply: this._policyText(policy) };
      case 'why':
        return { reply: this._whyText() };
      case 'pause':
        this.prefs.autoTrade = false;
        return {
          reply:
            'Standing down. The council will not open or close positions until you say "resume". ' +
            (this.mode === 'live' ? 'For a hard stop, use the on-chain kill switch (pauses the vault itself).' : ''),
        };
      case 'resume':
        this.prefs.autoTrade = true;
        return { reply: 'Back in session. The council resumes debating every tick.' };
      case 'closeAll': {
        const held = this.live.views.filter((v) => v.balance > 0);
        if (!held.length) return { reply: 'Nothing to close: the vault is fully in ' + this.info.baseSymbol + '.' };
        const lines = [];
        for (const v of held) {
          const d = await this._exitPosition(v.symbol, 'USER_EXIT');
          lines.push(this._tradeLine(d));
        }
        await this._refresh();
        return { reply: `Closed every position:\n${lines.join('\n')}` };
      }
      case 'close': {
        const sym = resolveSymbol(args.symbol, this.symbols);
        if (!sym) return { reply: `Unknown asset "${args.symbol}". I trade: ${this.symbols.join(', ')}.` };
        const v = this._view(sym);
        if (!(v.balance > 0)) return { reply: `No ${sym} position to close.` };
        const d = await this._exitPosition(sym, 'USER_EXIT');
        await this._refresh();
        return { reply: this._tradeLine(d) };
      }
      case 'analyze': {
        const sym = resolveSymbol(args.symbol, this.symbols) ?? this.prefs.targets[0] ?? this.symbols[0];
        const d = await this.runCouncil(sym, { execute: false });
        if (!d) return { reply: `Still collecting ${sym} prices (${this.history[sym]?.length ?? 0}/${WARMUP}).` };
        const lines = d.agents.map((a) => `${a.name} (${a.role}): ${a.stance} ${Math.round(a.confidence * 100)}%. ${a.rationale}`);
        return { reply: `${sym} @ ${fmtPrice(d.price)}: verdict ${d.action} (${d.votes}/${d.quorum}).\n${lines.join('\n')}` };
      }
      case 'preset': {
        const p = PRESETS[args.name];
        if (!p) return { reply: 'Presets: conservative, balanced, aggressive.' };
        return this._applyPolicy({ ...p }, `${args.name} preset`);
      }
      case 'setParam': {
        const key = String(args.key);
        if (!(key in policy)) return { reply: `Unknown setting ${key}.` };
        const value = Math.round(Number(args.value));
        return this._applyPolicy({ ...policy, [key]: value }, `${labelOf(key)} = ${fmtParam(key, value)}`);
      }
      case 'sizeMult': {
        const f = Number(args.factor) || 1;
        this.prefs.sizeMultiplier = round(clamp(this.prefs.sizeMultiplier * f, 0.1, 1), 2);
        return { reply: `Position sizing set to ${Math.round(this.prefs.sizeMultiplier * 100)}% of the on-chain cap.` };
      }
      case 'targets': {
        const syms = (args.symbols ?? []).map((s) => resolveSymbol(s, this.symbols)).filter(Boolean);
        if (args.mode === 'all') this.prefs.targets = [...this.symbols];
        else if (args.mode === 'only' && syms.length) this.prefs.targets = syms;
        else if (args.mode === 'add') this.prefs.targets = [...new Set([...this.prefs.targets, ...syms])];
        else if (args.mode === 'remove') this.prefs.targets = this.prefs.targets.filter((s) => !syms.includes(s));
        else return { reply: `Which asset? I can trade: ${this.symbols.join(', ')}.` };
        const tgt = this.prefs.targets.length ? this.prefs.targets.join(', ') : 'nothing (council idle)';
        return { reply: `Target assets: ${tgt}. Existing positions are still protected by stop-loss/take-profit.` };
      }
      case 'speed': {
        if (this.mode !== 'sim') return { reply: 'Speed control is only available in simulation mode.' };
        this.intervalMs = Math.round(clamp(this.intervalMs * (Number(args.factor) || 1), 500, 15_000));
        return { reply: `Simulation tick every ${(this.intervalMs / 1000).toFixed(1)}s.` };
      }
      case 'chat':
        return { reply: String(args.answer ?? '').slice(0, 800) || HELP_TEXT };
      default:
        return { reply: `I didn't catch that.\n${HELP_TEXT}` };
    }
  }

  async _applyPolicy(next, label) {
    const err = validatePolicy(next);
    if (err) return { reply: `Rejected: ${err}. The vault would refuse that policy too.` };
    if (this.vault.canSetPolicy && (await this.vault.canSetPolicy())) {
      const res = await this.vault.setPolicy(next);
      await this._refresh();
      return { reply: `Policy updated on-chain (${label}).\n${this._policyText(next)}`, txHash: res.txHash };
    }
    this.feedHoldUntil = Date.now() + 120_000;
    return {
      reply:
        `Policy change ready (${label}). Only the vault owner can sign it: approve the transaction in your wallet. ` +
        'The agent key is not allowed to loosen its own limits.',
      ownerTx: { method: 'setPolicy', policy: next },
    };
  }

  /**
   * Owner-only vault actions (kill switch, policy, breaker reset). Executed directly when this
   * process holds the owner key (always true in the simulation); otherwise returned as a
   * transaction for the owner's wallet to sign in the dashboard.
   */
  async ownerCall(method, arg) {
    const allowed = ['setPaused', 'setPolicy', 'resetCircuitBreaker'];
    if (!allowed.includes(method)) throw new Error(`unsupported owner method ${method}`);
    if (method === 'setPolicy') {
      const err = validatePolicy(arg);
      if (err) throw new Error(err);
    }
    if (this.vault.canSetPolicy && (await this.vault.canSetPolicy()) && typeof this.vault[method] === 'function') {
      const res = await this.vault[method](arg);
      await this._refresh();
      const msg =
        method === 'setPaused'
          ? arg
            ? 'KILL SWITCH ENGAGED: the vault is paused on-chain. The agent can do nothing until the owner unpauses.'
            : 'Kill switch released: the vault is unpaused.'
          : method === 'resetCircuitBreaker'
            ? 'Circuit breaker reset by the owner.'
            : `Policy updated on-chain.\n${this._policyText(arg)}`;
      this.chat.push({ role: 'agent', t: this.now, text: msg });
      this._emitState();
      return { done: true, txHash: res?.txHash ?? null };
    }
    // the owner will sign in their wallet: hold the demo price feed (same key) for up to 2 minutes
    this.feedHoldUntil = Date.now() + 120_000;
    return { done: false, ownerTx: { method, arg } };
  }

  releaseFeedHold() {
    this.feedHoldUntil = 0;
  }

  // ------------------------------------------------------------------ text helpers

  _statusLine() {
    const { snap } = this.live;
    return `equity ${fmtUsd(this.live.equity)}, base ${fmtUsd(snap.baseBalance)}, realized ${fmtUsd(snap.realizedPnlTotal)}, unrealized ${fmtUsd(this.live.unrealized)}, policy ${presetName(this.live.policy)}`;
  }

  _statusText() {
    const { snap, views, equity, unrealized } = this.live;
    const total = snap.realizedPnlTotal + unrealized;
    const capitalIn = snap.baseBalance + snap.totalCostBasis - snap.realizedPnlTotal;
    const pct = capitalIn > 0 ? ((snap.realizedPnlTotal + unrealized) / capitalIn) * 100 : 0;
    const pos = views
      .filter((v) => v.balance > 0)
      .map((v) => `• ${v.symbol}: ${fmtNum(v.balance)} @ ${fmtPrice(v.price)} = ${fmtUsd(v.value)} (${sign(v.pnlPct)}${v.pnlPct.toFixed(2)}%)`);
    return [
      `Equity ${fmtUsd(equity)} (${sign(pct)}${pct.toFixed(2)}% on capital). PnL ${sign(total)}${fmtUsd(total)}: realized ${fmtUsd(snap.realizedPnlTotal)}, unrealized ${fmtUsd(unrealized)}.`,
      `Cash: ${fmtUsd(snap.baseBalance)} ${this.info.baseSymbol}.`,
      pos.length ? `Positions:\n${pos.join('\n')}` : 'No open positions.',
      `Status: ${this._statusWord()}. Buys today ${snap.buysToday}/${this.live.policy.maxTradesPerDay}. Trades ${this.stats.trades}, vetoes ${this.stats.vetoes}, guardrail blocks ${this.stats.blocked}.`,
    ].join('\n');
  }

  _policyText(p) {
    return [
      `Policy (${presetName(p)}), enforced by the vault contract:`,
      `• max trade ${p.maxTradeBps / 100}% of cash · max position ${p.maxPositionBps / 100}% of equity`,
      `• stop-loss ${p.stopLossBps / 100}% · take-profit ${p.takeProfitBps / 100}% · slippage ≤ ${p.maxSlippageBps / 100}%`,
      `• daily loss breaker ${p.maxDailyLossBps / 100}% · ${p.maxTradesPerDay} buys/day · cooldown ${p.cooldown}s`,
      `• quorum ${p.quorum} of 3 · sizing ${Math.round(this.prefs.sizeMultiplier * 100)}% · assets ${this.prefs.targets.join(', ') || 'none'}`,
    ].join('\n');
  }

  _whyText() {
    const lastTrade = this.trades[0] ? this.archive.get(this.trades[0].id) : null;
    const d = lastTrade ?? this.decisions[0];
    if (!d) return 'No decisions yet. The council is still warming up.';
    const lines = d.agents.map((a) => `${a.name}: ${a.stance} (${Math.round(a.confidence * 100)}%). ${a.rationale}`);
    return [
      `Decision #${d.id}: ${d.action} ${d.symbol} @ ${fmtPrice(d.price)} (${d.votes}/${d.quorum} votes, trigger ${d.trigger}).`,
      ...lines,
      `Reasoning hash ${d.reasoningHash.slice(0, 18)}… is committed on-chain${d.txHash ? ` in tx ${d.txHash.slice(0, 14)}…` : ''}. Click "Verify" on the decision card to re-hash it yourself.`,
    ].join('\n');
  }

  _tradeLine(d) {
    if (!d) return 'Nothing to do.';
    if (d.status !== 'executed') return `${d.symbol}: exit failed (${d.error ?? d.status}).`;
    return `Sold ${fmtNum(d.sizing.amountIn)} ${d.symbol} for ${fmtUsd(d.result.amountOut)} (PnL ${sign(d.result.pnl)}${fmtUsd(d.result.pnl)}).`;
  }

  _statusWord() {
    const { snap } = this.live;
    if (snap.paused) return 'vault paused (kill switch)';
    if (!this.prefs.autoTrade) return 'standing down';
    if (snap.halted) return 'buys halted by circuit breaker';
    return 'live';
  }

  // ------------------------------------------------------------------ public views

  _decisionSummary(d) {
    return {
      id: d.id,
      t: d.t,
      symbol: d.symbol,
      action: d.action,
      intent: d.intent,
      votes: d.votes,
      quorum: d.quorum,
      confidence: d.confidence,
      summary: d.summary,
      trigger: d.trigger,
      price: d.price,
      agents: d.agents.map((a) => ({ id: a.id, name: a.name, stance: a.stance, confidence: a.confidence, rationale: a.rationale, veto: !!a.veto, source: a.source, color: a.color, role: a.role })),
      sizing: d.sizing,
      guardrail: d.guardrail,
      status: d.status,
      error: d.error ?? null,
      result: d.result ?? null,
      txHash: d.txHash ?? null,
      explorer: d.txHash ? this.vault.explorerTx(d.txHash) : null,
      reasoningHash: d.reasoningHash,
    };
  }

  getDecision(id) {
    const d = this.archive.get(Number(id));
    if (!d) return null;
    return { ...this._decisionSummary(d), json: d.json };
  }

  publicState() {
    const live = this.live ?? { snap: {}, policy: {}, views: [], equity: 0, unrealized: 0 };
    const { snap, policy, views, equity, unrealized } = live;
    const history = {};
    for (const s of this.symbols ?? []) {
      history[s] = (this.history[s] ?? []).slice(-240).map((h) => [h.t, round(h.price, 8), h.ref == null ? null : round(h.ref, 8)]);
    }
    const realized = snap.realizedPnlTotal ?? 0;
    return {
      mode: this.mode,
      info: this.info,
      now: this.now,
      intervalMs: this.intervalMs,
      status: this._statusWord(),
      statusCode: snap.paused ? 'paused' : !this.prefs.autoTrade ? 'standby' : snap.halted ? 'halted' : 'live',
      llm: !!this.llm,
      prefs: this.prefs,
      policy,
      preset: policy && Object.keys(policy).length ? presetName(policy) : 'custom',
      snap,
      positions: views.map((v) => ({ ...v, value: round(v.value, 6), pnl: round(v.pnl, 6), pnlPct: round(v.pnlPct, 3) })),
      equity: round(equity, 6),
      initialEquity: round(this.initialEquity ?? equity, 6),
      pnl: { realized: round(realized, 6), unrealized: round(unrealized, 6), total: round(realized + unrealized, 6) },
      history,
      equityCurve: this.equityCurve.slice(-240).map((e) => [e.t, e.equity]),
      decisions: this.decisions.slice(0, 40).map((d) => this._decisionSummary(d)),
      trades: this.trades.slice(0, 40).map((t) => ({ ...t, explorer: t.txHash ? this.vault.explorerTx(t.txHash) : null })),
      chat: this.chat.slice(-40),
      thinking: this.thinking,
      stats: this.stats,
      council: COUNCIL.map(({ id, name, role, color }) => ({ id, name, role, color })),
      lastError: this.lastError,
    };
  }
}

// ------------------------------------------------------------------ formatting

function sign(x) {
  return x > 0 ? '+' : '';
}
function fmtUsd(x) {
  const v = Number(x) || 0;
  return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(x) {
  const v = Number(x) || 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 6 });
}
function fmtPrice(x) {
  const v = Number(x) || 0;
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 5 });
}
const LABELS = {
  maxTradeBps: 'max trade size',
  maxPositionBps: 'max position',
  maxSlippageBps: 'max slippage',
  maxDailyLossBps: 'daily loss breaker',
  stopLossBps: 'stop-loss',
  takeProfitBps: 'take-profit',
  maxTradesPerDay: 'buys per day',
  cooldown: 'cooldown',
  quorum: 'quorum',
};
function labelOf(k) {
  return LABELS[k] ?? k;
}
function fmtParam(k, v) {
  if (k.endsWith('Bps')) return `${v / 100}%`;
  if (k === 'cooldown') return `${v}s`;
  return String(v);
}
