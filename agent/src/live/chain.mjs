// LiveVault: the same interface as SimVault, backed by the real QuorumVault on HSK Chain.
import { ethers } from 'ethers';

const POLICY_T =
  'tuple(uint16 maxTradeBps,uint16 maxPositionBps,uint16 maxSlippageBps,uint16 maxDailyLossBps,uint16 stopLossBps,uint16 takeProfitBps,uint16 maxTradesPerDay,uint32 cooldown,uint8 quorum)';
const TRADE_T = 'tuple(address token,uint256 amountIn,uint256 expectedOut,uint256 minOut,bytes32 reasoningHash,uint8 votes)';

export const VAULT_ABI = [
  'function baseToken() view returns (address)',
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function adapter() view returns (address)',
  `function policy() view returns (${POLICY_T})`,
  'function snapshot() view returns (tuple(uint256 baseBalance,uint256 totalCostBasis,int256 realizedPnlTotal,uint256 realizedLossToday,uint256 dayStartEquity,uint16 buysToday,uint64 lastBuyAt,uint64 haltedUntil,bool halted,bool paused,uint256 tradeCount,uint256 timestamp))',
  'function positions() view returns (address[] list,uint256[] balances,uint256[] costs,bool[] allowed)',
  `function buy(${TRADE_T} t) returns (uint256)`,
  `function sell(${TRADE_T} t) returns (uint256)`,
  'function attest(bytes32 reasoningHash,uint8 action,uint8 votes)',
  `function setPolicy(${POLICY_T} p)`,
  'function setPaused(bool paused_)',
  'function deposit(uint256 amount)',
  'function withdraw(address token,uint256 amount,address to)',
  'function resetCircuitBreaker()',
  'event TradeExecuted(uint256 indexed id,address indexed token,tuple(bool isBuy,uint256 amountIn,uint256 amountOut,uint256 expectedOut,int256 pnl,bytes32 reasoningHash,uint8 votes) record)',
  'event DecisionAttested(bytes32 indexed reasoningHash,uint8 action,uint8 votes)',
  'error NotOwner()',
  'error NotAgent()',
  'error VaultPaused()',
  'error BuysHalted()',
  'error TokenNotAllowed()',
  'error ZeroAmount()',
  'error ZeroAddress()',
  'error TradeTooLarge()',
  'error PositionTooLarge()',
  'error CooldownActive()',
  'error DailyTradeLimit()',
  'error QuorumNotMet()',
  'error SlippageTooWide()',
  'error InsufficientOutput()',
  'error InsufficientBalance()',
  'error InvalidPolicy()',
  'error Reentrancy()',
  'error TransferFailed()',
  'error ApproveFailed()',
  'error NotAContract()',
];

export const ADAPTER_ABI = [
  'function quote(address tokenIn,address tokenOut,uint256 amountIn) returns (uint256)',
  'function setRate(address tokenIn,address tokenOut,uint256 rate1e18)',
  'function setRates(address[] tokensIn,address[] tokensOut,uint256[] rates1e18)',
  'function rate(address,address) view returns (uint256)',
  'function deployer() view returns (address)',
  'error NoRate()',
  'error Slippage()',
  'error NotVault()',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

const NETWORKS = {
  177: { name: 'HSK Chain Mainnet', explorer: 'https://hsk.blockscout.com' },
  133: { name: 'HSK Chain Testnet', explorer: 'https://testnet-explorer.hsk.xyz' },
};

/** float -> bigint with `decimals`, never more precise than the token allows */
export function toUnits(x, decimals) {
  const d = Math.min(Number(decimals), 18);
  const fixed = Math.max(0, Number(x)).toFixed(Math.min(d, 12));
  return ethers.parseUnits(fixed, d);
}

export function fromUnits(v, decimals) {
  return Number(ethers.formatUnits(v, decimals));
}

function errCode(e) {
  return e?.revert?.name ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message ?? String(e);
}

export class LiveVault {
  /**
   * @param {{rpcUrl:string, vaultAddress:string, agentKey:string, chainId?:number, explorer?:string, probeAmount?:number}} o
   */
  static async connect(o) {
    const provider = new ethers.JsonRpcProvider(o.rpcUrl, o.chainId ? Number(o.chainId) : undefined);
    const net = await provider.getNetwork();
    const wallet = new ethers.Wallet(o.agentKey, provider);
    const v = new LiveVault();
    v.mode = 'live';
    v.provider = provider;
    v.wallet = wallet;
    v.chainId = Number(net.chainId);
    v.explorer = o.explorer || NETWORKS[v.chainId]?.explorer || null;
    v.network = NETWORKS[v.chainId]?.name ?? `chain ${v.chainId}`;
    v.address = ethers.getAddress(o.vaultAddress);
    v.vault = new ethers.Contract(v.address, VAULT_ABI, wallet);
    v.probeAmount = o.probeAmount ?? 1;

    const [base, owner, agent, adapterAddr, list] = await Promise.all([
      v.vault.baseToken(),
      v.vault.owner(),
      v.vault.agent(),
      v.vault.adapter(),
      v.vault.positions(),
    ]);
    if (agent.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`AGENT_PRIVATE_KEY is ${wallet.address} but the vault's agent is ${agent}. Call setAgent() or fix the key.`);
    }
    v.owner = owner;
    v.agentAddress = agent;
    v.adapterAddress = adapterAddr;
    v.adapter = new ethers.Contract(adapterAddr, ADAPTER_ABI, wallet);
    v.base = await v._tokenMeta(base);
    v.tokens = {};
    for (const addr of list.list ?? list[0]) {
      const meta = await v._tokenMeta(addr);
      let sym = meta.symbol;
      if (v.tokens[sym] || sym === v.base.symbol) sym = `${sym}_${addr.slice(2, 6)}`;
      v.tokens[sym] = { ...meta, symbol: sym };
    }
    if (!Object.keys(v.tokens).length) throw new Error('The vault has no whitelisted tokens. Call setTokenAllowed() as the owner.');
    return v;
  }

  async _tokenMeta(address) {
    const c = new ethers.Contract(address, ERC20_ABI, this.provider);
    const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
    return { address: ethers.getAddress(address), symbol, decimals: Number(decimals) };
  }

  explorerTx(hash) {
    return this.explorer ? `${this.explorer}/tx/${hash}` : null;
  }

  async info() {
    return {
      mode: 'live',
      chainId: this.chainId,
      network: this.network,
      vault: this.address,
      owner: this.owner,
      agent: this.agentAddress,
      adapter: this.adapterAddress,
      baseSymbol: this.base.symbol,
      baseToken: this.base.address,
      baseDecimals: this.base.decimals,
      symbols: Object.keys(this.tokens),
      tokens: this.tokens,
      explorer: this.explorer,
    };
  }

  async policy() {
    const p = await this.vault.policy();
    return {
      maxTradeBps: Number(p.maxTradeBps),
      maxPositionBps: Number(p.maxPositionBps),
      maxSlippageBps: Number(p.maxSlippageBps),
      maxDailyLossBps: Number(p.maxDailyLossBps),
      stopLossBps: Number(p.stopLossBps),
      takeProfitBps: Number(p.takeProfitBps),
      maxTradesPerDay: Number(p.maxTradesPerDay),
      cooldown: Number(p.cooldown),
      quorum: Number(p.quorum),
    };
  }

  async snapshot() {
    const s = await this.vault.snapshot();
    const d = this.base.decimals;
    return {
      baseBalance: fromUnits(s.baseBalance, d),
      totalCostBasis: fromUnits(s.totalCostBasis, d),
      realizedPnlTotal: fromUnits(s.realizedPnlTotal, d),
      realizedLossToday: fromUnits(s.realizedLossToday, d),
      dayStartEquity: fromUnits(s.dayStartEquity, d),
      buysToday: Number(s.buysToday),
      lastBuyAt: Number(s.lastBuyAt),
      haltedUntil: Number(s.haltedUntil),
      halted: s.halted,
      paused: s.paused,
      tradeCount: Number(s.tradeCount),
      timestamp: Number(s.timestamp),
    };
  }

  async positions() {
    const r = await this.vault.positions();
    const out = [];
    for (const [sym, t] of Object.entries(this.tokens)) {
      const i = r.list.findIndex((a) => a.toLowerCase() === t.address.toLowerCase());
      if (i < 0) continue;
      out.push({
        symbol: sym,
        address: t.address,
        balance: fromUnits(r.balances[i], t.decimals),
        cost: fromUnits(r.costs[i], this.base.decimals),
        allowed: r.allowed[i],
      });
    }
    return out;
  }

  /** Mid-ish price of `symbol` in base units, from the venue quoter. */
  async price(symbol) {
    const t = this.tokens[symbol];
    const amountIn = toUnits(this.probeAmount, this.base.decimals);
    const out = await this.adapter.quote.staticCall(this.base.address, t.address, amountIn);
    if (out === 0n) return 0;
    return this.probeAmount / fromUnits(out, t.decimals);
  }

  async quote(symbol, side, amountIn) {
    const t = this.tokens[symbol];
    if (side === 'buy') {
      const out = await this.adapter.quote.staticCall(this.base.address, t.address, toUnits(amountIn, this.base.decimals));
      return fromUnits(out, t.decimals);
    }
    const out = await this.adapter.quote.staticCall(t.address, this.base.address, toUnits(amountIn, t.decimals));
    return fromUnits(out, this.base.decimals);
  }

  async _trade(side, { symbol, amountIn, slippageBps, reasoningHash, votes }) {
    const t = this.tokens[symbol];
    if (!t) throw Object.assign(new Error('TokenNotAllowed'), { code: 'TokenNotAllowed' });
    const isBuy = side === 'buy';
    const tokenIn = isBuy ? this.base : t;
    const tokenOut = isBuy ? t : this.base;
    let amt = toUnits(amountIn, tokenIn.decimals);
    if (!isBuy) {
      const bal = await new ethers.Contract(t.address, ERC20_ABI, this.provider).balanceOf(this.address);
      if (amt > bal || Number(amountIn) >= fromUnits(bal, t.decimals) * 0.999999) amt = bal; // full exit, no dust
    }
    if (amt === 0n) throw Object.assign(new Error('ZeroAmount'), { code: 'ZeroAmount' });
    const expectedOut = await this.adapter.quote.staticCall(tokenIn.address, tokenOut.address, amt);
    if (expectedOut === 0n) throw Object.assign(new Error('NoLiquidity'), { code: 'NoLiquidity' });
    const minOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const args = { token: t.address, amountIn: amt, expectedOut, minOut, reasoningHash, votes };
    try {
      const tx = isBuy ? await this.vault.buy(args) : await this.vault.sell(args);
      const receipt = await tx.wait();
      let amountOut = 0;
      let pnl = 0;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
        try {
          const parsed = this.vault.interface.parseLog(log);
          if (parsed?.name === 'TradeExecuted') {
            amountOut = fromUnits(parsed.args.record.amountOut, tokenOut.decimals);
            pnl = fromUnits(parsed.args.record.pnl, this.base.decimals);
          }
        } catch {
          /* not ours */
        }
      }
      return {
        txHash: receipt.hash,
        amountOut,
        expectedOut: fromUnits(expectedOut, tokenOut.decimals),
        minOut: fromUnits(minOut, tokenOut.decimals),
        pnl,
      };
    } catch (e) {
      throw Object.assign(new Error(errCode(e)), { code: errCode(e) });
    }
  }

  buy(args) {
    return this._trade('buy', args);
  }

  sell(args) {
    return this._trade('sell', args);
  }

  async attest(reasoningHash, action, votes) {
    try {
      const tx = await this.vault.attest(reasoningHash, action, votes);
      const r = await tx.wait();
      return { txHash: r.hash };
    } catch (e) {
      throw Object.assign(new Error(errCode(e)), { code: errCode(e) });
    }
  }

  async canSetPolicy() {
    return this.owner.toLowerCase() === this.wallet.address.toLowerCase();
  }

  async setPolicy(p) {
    const tx = await this.vault.setPolicy(p);
    const r = await tx.wait();
    return { txHash: r.hash };
  }

  async setPaused(v) {
    const r = await (await this.vault.setPaused(!!v)).wait();
    return { txHash: r.hash };
  }

  async resetCircuitBreaker() {
    const r = await (await this.vault.resetCircuitBreaker()).wait();
    return { txHash: r.hash };
  }
}

/**
 * For the DeployDemo venue (MockAdapter): pushes simulated prices on-chain so the live demo
 * shows real transactions even when real DEX liquidity is thin. Needs the adapter deployer key.
 */
export class MockPricePusher {
  /**
   * @param {{vault: LiveVault, key: string, minMove?: number}} o
   *   minMove: only push a symbol when its price moved at least this fraction (default 0.2%)
   */
  constructor({ vault, key, minMove = 0.002 }) {
    this.vault = vault;
    this.signer = new ethers.Wallet(key, vault.provider);
    this.adapter = new ethers.Contract(vault.adapterAddress, ADAPTER_ABI, this.signer);
    this.minMove = minMove;
    this.last = {};
  }

  async check() {
    const dep = await this.adapter.deployer();
    if (dep.toLowerCase() !== this.signer.address.toLowerCase()) {
      throw new Error(`MOCK_FEED_PRIVATE_KEY is ${this.signer.address}, adapter deployer is ${dep}`);
    }
  }

  _rates(symbol, price) {
    const t = this.vault.tokens[symbol];
    const b = this.vault.base;
    const priceWad = ethers.parseUnits(price.toFixed(12), 18);
    if (priceWad === 0n) return null;
    const tokToBase = (priceWad * 10n ** BigInt(b.decimals)) / 10n ** BigInt(t.decimals);
    const baseToTok = (10n ** 36n * 10n ** BigInt(t.decimals)) / (priceWad * 10n ** BigInt(b.decimals));
    return { t, b, tokToBase, baseToTok };
  }

  /**
   * Push all prices that moved enough in ONE transaction (needs the MockAdapter with setRates).
   * Falls back to one-by-one setRate on an older adapter.
   * @param {Record<string, number>} prices base units per 1 token
   * @returns {Promise<number>} how many symbols were updated
   */
  async pushAll(prices) {
    const ins = [];
    const outs = [];
    const rates = [];
    const changed = [];
    for (const [symbol, price] of Object.entries(prices)) {
      const prev = this.last[symbol];
      if (prev && Math.abs(price / prev - 1) < this.minMove) continue;
      const r = this._rates(symbol, price);
      if (!r) continue;
      ins.push(r.t.address, r.b.address);
      outs.push(r.b.address, r.t.address);
      rates.push(r.tokToBase, r.baseToTok);
      changed.push([symbol, price]);
    }
    if (!changed.length) return 0;
    let batched = false;
    if (!this.batchUnsupported) {
      try {
        await (await this.adapter.setRates(ins, outs, rates)).wait();
        batched = true;
      } catch {
        // an adapter deployed before update 1 has no setRates: remember it and use single updates
        this.batchUnsupported = true;
      }
    }
    if (!batched) {
      for (let i = 0; i < ins.length; i++) await (await this.adapter.setRate(ins[i], outs[i], rates[i])).wait();
    }
    for (const [s, p] of changed) this.last[s] = p;
    return changed.length;
  }

  /** price = base units per 1 token (single symbol) */
  async push(symbol, price) {
    return this.pushAll({ [symbol]: price });
  }
}
