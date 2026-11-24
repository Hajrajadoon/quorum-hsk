// In-memory replica of QuorumVault (same rules, same error names) used for demo mode and tests.
// Amounts are plain JS numbers in human units (base asset units, token units).

import { keccak256Utf8 } from './keccak.mjs';
import { PRESETS, validatePolicy } from './presets.mjs';

export class VaultError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const DAY = 86_400;

export class SimVault {
  /**
   * @param {{market: import('./simMarket.mjs').SimMarket, baseSymbol?: string, deposit?: number,
   *          policy?: object, feeBps?: number}} opts
   */
  constructor(opts) {
    this.market = opts.market;
    this.mode = 'sim';
    this.baseSymbol = opts.baseSymbol ?? 'USDT';
    this.feeBps = opts.feeBps ?? 30;
    this.address = '0x' + keccak256Utf8('quorum-sim-vault').slice(2, 42);
    this.chainId = 0;
    this._policy = { ...(opts.policy ?? PRESETS.balanced) };
    this.paused = false;
    this.base = 0;
    this.tokens = {};
    for (const s of this.market.symbols()) this.tokens[s] = { balance: 0, cost: 0, allowed: true };
    this.totalCost = 0;
    this.currentDay = Math.floor(this.now() / DAY);
    this.lastBuyAt = 0;
    this.haltedUntil = 0;
    this.buysToday = 0;
    this.dayStartEquity = 0;
    this.lossToday = 0;
    this.pnlTotal = 0;
    this.tradeCount = 0;
    this._txNonce = 0;
    if (opts.deposit) this.deposit(opts.deposit);
  }

  now() {
    return this.market.time;
  }

  _fakeTx() {
    this._txNonce += 1;
    return keccak256Utf8(`quorum-sim-tx-${this._txNonce}`);
  }

  explorerTx() {
    return null;
  }

  _rollDay() {
    const today = Math.floor(this.now() / DAY);
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.buysToday = 0;
      this.lossToday = 0;
      this.dayStartEquity = this.base + this.totalCost;
    }
  }

  // ----------------------------------------------------------- owner

  deposit(amount) {
    if (!(amount > 0)) throw new VaultError('ZeroAmount');
    this._rollDay();
    this.base += amount;
    this.dayStartEquity += amount;
  }

  async canSetPolicy() {
    return true; // in the simulation the dashboard user is the vault owner
  }

  async setPolicy(p) {
    const err = validatePolicy(p);
    if (err) throw new VaultError('InvalidPolicy', err);
    this._policy = { ...p };
    return { txHash: this._fakeTx() };
  }

  async setPaused(v) {
    this.paused = !!v;
    return { txHash: this._fakeTx() };
  }

  async setTokenAllowed(symbol, allowed) {
    if (!this.tokens[symbol]) throw new VaultError('TokenNotAllowed');
    this.tokens[symbol].allowed = !!allowed;
    return { txHash: this._fakeTx() };
  }

  async resetCircuitBreaker() {
    this.haltedUntil = 0;
    this.lossToday = 0;
    return { txHash: this._fakeTx() };
  }

  // ----------------------------------------------------------- views

  async policy() {
    return { ...this._policy };
  }

  async snapshot() {
    const now = this.now();
    const sameDay = Math.floor(now / DAY) === this.currentDay;
    return {
      baseBalance: this.base,
      totalCostBasis: this.totalCost,
      realizedPnlTotal: this.pnlTotal,
      realizedLossToday: sameDay ? this.lossToday : 0,
      dayStartEquity: sameDay ? this.dayStartEquity : this.base + this.totalCost,
      buysToday: sameDay ? this.buysToday : 0,
      lastBuyAt: this.lastBuyAt,
      haltedUntil: this.haltedUntil,
      halted: now < this.haltedUntil,
      paused: this.paused,
      tradeCount: this.tradeCount,
      timestamp: now,
    };
  }

  async positions() {
    return Object.entries(this.tokens).map(([symbol, t]) => ({
      symbol,
      address: '0x' + keccak256Utf8(`sim-token-${symbol}`).slice(2, 42),
      balance: t.balance,
      cost: t.cost,
      allowed: t.allowed,
    }));
  }

  async info() {
    return {
      mode: 'sim',
      chainId: 0,
      network: 'Simulation (HSK Chain replica)',
      vault: this.address,
      baseSymbol: this.baseSymbol,
      symbols: Object.keys(this.tokens),
      explorer: null,
    };
  }

  async quote(symbol, side, amountIn) {
    const price = this.market.price(symbol);
    if (!(price > 0)) throw new VaultError('NoRate', symbol);
    const fee = 1 - this.feeBps / 10_000;
    return side === 'buy' ? (amountIn / price) * fee : amountIn * price * fee;
  }

  // ----------------------------------------------------------- agent

  _validate(t, symbol) {
    if (this.paused) throw new VaultError('VaultPaused');
    if (!(t.amountIn > 0)) throw new VaultError('ZeroAmount');
    if (!this.tokens[symbol]) throw new VaultError('TokenNotAllowed');
    if (t.votes < this._policy.quorum) throw new VaultError('QuorumNotMet', `${t.votes}/${this._policy.quorum}`);
    if (t.slippageBps > this._policy.maxSlippageBps) throw new VaultError('SlippageTooWide');
  }

  /** @param {{symbol:string, amountIn:number, slippageBps:number, reasoningHash:string, votes:number}} t */
  async buy(t) {
    const tok = this.tokens[t.symbol];
    this._validate(t, t.symbol);
    if (!tok.allowed) throw new VaultError('TokenNotAllowed');
    this._rollDay();
    const now = this.now();
    if (now < this.haltedUntil) throw new VaultError('BuysHalted');
    if (this.lastBuyAt !== 0 && now < this.lastBuyAt + this._policy.cooldown) throw new VaultError('CooldownActive');
    if (this.buysToday >= this._policy.maxTradesPerDay) throw new VaultError('DailyTradeLimit');
    if (t.amountIn * 10_000 > this._policy.maxTradeBps * this.base * (1 + 1e-9)) throw new VaultError('TradeTooLarge');
    const equity = this.base + this.totalCost;
    if ((tok.cost + t.amountIn) * 10_000 > this._policy.maxPositionBps * equity * (1 + 1e-9)) {
      throw new VaultError('PositionTooLarge');
    }
    const expectedOut = await this.quote(t.symbol, 'buy', t.amountIn);
    const minOut = expectedOut * (1 - t.slippageBps / 10_000);
    const amountOut = expectedOut; // venue fills at quote
    if (amountOut < minOut) throw new VaultError('InsufficientOutput');

    this.buysToday += 1;
    this.lastBuyAt = now;
    this.base -= t.amountIn;
    tok.balance += amountOut;
    tok.cost += t.amountIn;
    this.totalCost += t.amountIn;
    this.tradeCount += 1;
    return { txHash: this._fakeTx(), amountOut, expectedOut, minOut, pnl: 0, tradeId: this.tradeCount };
  }

  async sell(t) {
    const tok = this.tokens[t.symbol];
    this._validate(t, t.symbol);
    if (!tok.allowed && tok.cost === 0) throw new VaultError('TokenNotAllowed');
    this._rollDay();
    const amountIn = Math.min(t.amountIn, tok.balance);
    if (t.amountIn > tok.balance * (1 + 1e-9)) throw new VaultError('InsufficientBalance');
    const costPortion = tok.balance > 0 ? (tok.cost * amountIn) / tok.balance : 0;
    const expectedOut = await this.quote(t.symbol, 'sell', amountIn);
    const minOut = expectedOut * (1 - t.slippageBps / 10_000);
    const amountOut = expectedOut;
    if (amountOut < minOut) throw new VaultError('InsufficientOutput');

    tok.balance -= amountIn;
    if (tok.balance < 1e-12) tok.balance = 0;
    tok.cost = tok.balance === 0 ? 0 : Math.max(0, tok.cost - costPortion);
    this.totalCost = Math.max(0, this.totalCost - costPortion);
    this.base += amountOut;
    const pnl = amountOut - costPortion;
    this.pnlTotal += pnl;
    if (pnl < 0) {
      this.lossToday += -pnl;
      const limit = (this.dayStartEquity * this._policy.maxDailyLossBps) / 10_000;
      if (this.lossToday > limit && this.now() >= this.haltedUntil) {
        this.haltedUntil = (this.currentDay + 1) * DAY;
      }
    }
    this.tradeCount += 1;
    return { txHash: this._fakeTx(), amountOut, expectedOut, minOut, pnl, tradeId: this.tradeCount };
  }

  async attest() {
    if (this.paused) throw new VaultError('VaultPaused');
    return { txHash: this._fakeTx() };
  }
}
