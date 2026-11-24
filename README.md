<p align="center"><img src="docs/assets/logo.png" alt="QUORUM" width="460"></p>

# QUORUM: an AI trading council that can't go rogue

> **Track 1 · AI Agent Trading** · HSK Chain Hackathon · Seoul 2026

Three AI agents debate every trade. A smart contract makes sure that even when they agree, they can never break your rules.
Each decision's full reasoning is hashed and committed on-chain, so anyone can verify *why* the agent traded.

```
 Atlas  (Momentum Quant)        ┐
 Nyx    (Contrarian & Arbitrage)├─► quorum vote ─► off-chain risk engine ─► QuorumVault (HSK Chain) ─► HSKSwap
 Sentinel (Risk Officer · VETO) ┘        │                                     │
                                         └── keccak256(reasoning) ─────────────┘  "Proof of Reasoning"
```

**Website:** `docs/index.html` (landing page) · **Live demo:** `docs/demo.html`. To host both for free, enable GitHub Pages: repo **Settings → Pages → Deploy from a branch → `main` / `/docs`**.

## Why this matters

Autonomous trading agents have a trust problem. If you give an AI a private key, it can do *anything* with your money.
A bug, a hallucination or a prompt injection can drain the account. Most "AI trading bots" ask you to trust the bot.
QUORUM asks you to trust **math and a contract**:

| Problem | QUORUM's answer |
|---|---|
| A single model hallucinates a trade | **Council of 3 agents** with different mandates. A trade needs a **quorum** (2/3 by default, 3/3 in conservative mode). |
| The AI ignores risk | **Sentinel** holds a **hard veto**. It is computed deterministically, and an LLM can explain the veto but cannot lift it. |
| The bot key gets stolen or goes rogue | The agent key **can never withdraw**. Max trade size, max position, slippage, cooldown, buys per day and quorum are all **enforced by `QuorumVault`**. |
| A bad day wipes you out | An on-chain **daily-loss circuit breaker** halts new buys until the next UTC day. Exits are never blocked. |
| "Why did it do that?" | **Proof of Reasoning**: every decision's full transcript is hashed with keccak256 and emitted on-chain. Click **Verify** and your browser re-hashes it. Try tampering and see it fail. |
| Users can't tune a bot | **Chat control**: "be more conservative", "stop loss 2%", "only trade HSK", "why did you sell?", "close all". Policy changes need the **owner's wallet signature**, so the agent can't loosen its own limits. |

## What's in the box

```
contracts/   Foundry project
  src/QuorumVault.sol            guarded vault: policy, quorum, circuit breaker, proof-of-reasoning events
  src/adapters/UniswapV3Adapter  HSKSwap V3 (SwapRouter02 or legacy SwapRouter + QuoterV2)
  src/adapters/UniswapV2Adapter  HSKSwap V2-style routers
  src/mocks/                     MockERC20 + MockAdapter (tests and the demo venue)
  test/QuorumVault.t.sol         25 tests incl. fuzzing
  script/Deploy.s.sol            real HSKSwap deployment
  script/DeployDemo.s.sol        self-contained demo deployment (tokens + venue + funded vault)
agent/       Node.js (only dependency: ethers)
  src/core/    engine, council, risk engine, chat, keccak, simulator (runs in Node AND the browser)
  src/live/    HSK Chain connection, market feed, OpenAI-compatible LLM client
  public/      the dashboard (zero build step)
  test/        11 tests: guardrail parity with the contract, veto can't be lifted, hashes verify, chat
  dist/quorum-demo.html          one-file offline demo (engine runs in the browser)
docs/        DEPLOY.md · PITCH.md · SUBMISSION.md
```

## Run it in 60 seconds (no keys, no chain)

```bash
cd agent
npm install
npm run demo          # → http://127.0.0.1:8787
npm test              # 11 agent tests
```

Or just open `agent/dist/quorum-demo.html` in a browser. It is the entire system in one file, and it works offline.

## Go live on HSK Chain mainnet

Full step-by-step instructions are in **[docs/DEPLOY.md](docs/DEPLOY.md)**. In short:

```bash
cd contracts && ./setup.sh                                   # installs forge-std, builds, runs the tests
forge script script/DeployDemo.s.sol --rpc-url hsk_mainnet --broadcast   # or Deploy.s.sol for real HSKSwap
cd ../agent && cp .env.example .env                          # MODE=live, VAULT_ADDRESS, AGENT_PRIVATE_KEY
npm run live
```

## How a decision is made

1. **Market.** The agent reads the venue price from the on-chain quoter and, optionally, a reference price (CoinGecko). From these it computes EMA8/21, RSI, z-score, momentum, volatility regime and the **DEX-vs-reference spread** (arbitrage).
2. **Debate.** Each council member votes BUY/SELL/HOLD with a confidence score and a rationale. With an LLM key, each agent reasons in its own persona, grounded in the same numbers. Without a key, deterministic quant models vote. Either way, Sentinel's hard veto is computed by code.
3. **Tally.** A trade needs `policy.quorum` votes. If a quorum to buy forms but Sentinel vetoes, the result is a **VETO**.
4. **Guardrails.** The off-chain risk engine mirrors every contract rule. It sizes by confidence × the user's size preference and clips to every cap, so the agent never sends a transaction the vault would reject.
5. **Proof.** The decision record (votes, rationales, features, sizing, policy) is serialized to canonical JSON and hashed with keccak256. The hash goes on-chain *inside the trade transaction* (`TradeExecuted.record.reasoningHash`) or via `attest()` for HOLD/VETO decisions.
6. **Exits.** Stop-loss and take-profit come from the on-chain policy and run before any debate. Sells are never blocked by cooldowns or the circuit breaker.

## Security model

| Actor | Can | Cannot |
|---|---|---|
| Owner (your wallet) | deposit, withdraw, set policy, pause (kill switch), change agent/adapter, reset the breaker | – |
| Agent key (hot, on the server) | `buy`/`sell` whitelisted tokens within the policy, `attest` | withdraw, change policy, unpause, trade non-whitelisted tokens, exceed any limit |
| Adapter | swap tokens the vault sent it, to the vault | be called by anyone except its bound vault |
| Anyone | read everything, verify every reasoning hash | – |

Other protections: output is measured by balance delta (the adapter is never trusted), the vault is non-reentrant, USDT-style tokens are supported (no return value, reset-to-zero approvals), and policy validation is identical on-chain and off-chain.

## Honest limitations

- **Thin liquidity.** HSKSwap mainnet liquidity is thin for most pairs. `DeployDemo` ships a fixed-rate demo venue whose price follows a simulated feed, so the live demo shows real mainnet transactions. `Deploy` targets the real HSKSwap routers.
- **Stop-loss price source.** The on-chain circuit breaker uses *realized* PnL (no oracle needed). Stop-loss and take-profit are triggered by the agent from venue quotes, with thresholds read from the contract.
- **Self-reported votes.** The vault checks the vote count the agent reports. The count can be audited against the committed transcript, but it is not proven in zero-knowledge.

## Roadmap

HSP agent-to-agent payments (the council buys signals from third-party signal agents and pays per call) · multi-user vault shares (ERC-4626) · Chainlink/Supra oracle for on-chain stop-loss · TEE-attested agent runtime.

MIT licensed.
