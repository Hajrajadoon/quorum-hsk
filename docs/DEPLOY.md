# Deploying QUORUM to HSK Chain mainnet

To claim a prize, **the smart contract must be deployed on HSK Chain mainnet** (chain id 177).
Budget about 1–2 hours the first time.

| | Mainnet | Testnet |
|---|---|---|
| RPC | https://mainnet.hsk.xyz | https://testnet.hsk.xyz |
| Chain id | 177 | 133 |
| Explorer | https://hsk.blockscout.com | https://testnet-explorer.hsk.xyz |
| Gas token | HSK | HSK |

> Always verify contract addresses (USDT, WHSK, HSKSwap router and quoter) yourself, on the explorer and in the official HSKSwap / HashFans docs. Never copy them from random repos.

---

## 0. Install tools

- **Node.js 20+**: https://nodejs.org
- **Foundry**: https://book.getfoundry.sh/getting-started/installation
  - macOS/Linux: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
  - Windows: use **WSL (Ubuntu)** and run the same commands inside it.
- **MetaMask** with HSK Chain added. The dashboard adds it for you when you click "Connect owner wallet".

## 1. Create two wallets

| Wallet | Purpose | Where the key lives |
|---|---|---|
| **Owner** | deploys, funds, sets policy, kill switch, withdraws | your MetaMask / `contracts/.env` only while deploying |
| **Agent** | the AI's hot key: trades only, can never withdraw | `agent/.env` on the server |

```bash
cast wallet new        # run it once for the agent; save the address + private key
```

Send a little **HSK for gas** to both addresses: about 0.5 HSK for the owner and 0.5 HSK for the agent is plenty on HSK Chain.

## 2. Build and test the contracts

```bash
cd contracts
./setup.sh             # installs forge-std, forge build, forge test (expect: all tests pass)
cp .env.example .env   # fill PRIVATE_KEY (owner) and AGENT_ADDRESS
```

## 3A. Demo deployment (recommended for Demo Day)

This deploys demo tokens, a demo venue, a vault funded with 10,000 qUSD and a whitelist of qHSK and qETH.
The agent's price feed then moves the venue price, so the stage demo shows **real mainnet transactions** every tick.

```bash
source .env
forge script script/DeployDemo.s.sol --rpc-url hsk_mainnet --broadcast \
  --verify --verifier blockscout --verifier-url https://hsk.blockscout.com/api/
```

Copy the printed `QuorumVault` address.

## 3B. Real HSKSwap deployment (shows the real integration)

1. Look up the addresses on the explorer and HSKSwap: the **USDT** token, **WHSK**, the **SwapRouter**, and the **QuoterV2**. Check whether the router is `SwapRouter02` (no `deadline` in `exactInputSingle`) or the legacy `SwapRouter` (has a `deadline`). Set `V3_LEGACY` to match.
2. Fill `BASE_TOKEN`, `TRADE_TOKENS`, `ADAPTER_KIND=v3`, `ROUTER`, `QUOTER` and `V3_FEE` (the pool fee tier, e.g. 3000) in `contracts/.env`.
3. Deploy:

```bash
source .env
forge script script/Deploy.s.sol --rpc-url hsk_mainnet --broadcast \
  --verify --verifier blockscout --verifier-url https://hsk.blockscout.com/api/
```

4. Fund the vault. Check the decimals first: USDT is usually 6.

```bash
cast call $BASE_TOKEN "decimals()(uint8)" --rpc-url hsk_mainnet
cast send $BASE_TOKEN "approve(address,uint256)" <VAULT> 20000000 --rpc-url hsk_mainnet --private-key $PRIVATE_KEY   # 20 USDT if 6 decimals
cast send <VAULT> "deposit(uint256)" 20000000 --rpc-url hsk_mainnet --private-key $PRIVATE_KEY
```

If the pool's fee tier is not the default, run this as the deployer: `cast send <ADAPTER> "setFee(address,address,uint24)" <USDT> <WHSK> 500 ...`.

## 4. Run the agent against the vault

```bash
cd ../agent
npm install
cp .env.example .env
```

Set these in `agent/.env`:

```
MODE=live
RPC_URL=https://mainnet.hsk.xyz
CHAIN_ID=177
VAULT_ADDRESS=0x...        # from step 3
AGENT_PRIVATE_KEY=0x...    # the agent wallet from step 1
LOOP_MS=20000
# 3A demo venue only: the deployer key that may move the demo prices
MOCK_FEED_PRIVATE_KEY=0x...
# optional AI
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-...
LLM_MODEL=anthropic/claude-3.5-haiku
```

```bash
npm run live               # → http://127.0.0.1:8787
```

The agent checks that `AGENT_PRIVATE_KEY` really is the vault's agent and refuses to start otherwise.
Every trade's "Verify" button links to the transaction on Blockscout.

## 5. Owner actions from the dashboard

Click **Connect owner wallet**. Policy presets, chat commands such as "stop loss 2%", and the **Kill switch** then open a MetaMask transaction for the owner to sign.
The agent never holds the owner key.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `AGENT_PRIVATE_KEY is 0x… but the vault's agent is 0x…` | Use the right key, or call `setAgent` from the owner. |
| `The vault has no whitelisted tokens` | Run `cast send <VAULT> "setTokenAllowed(address,bool)" <TOKEN> true` as the owner. |
| Trades rejected with `InsufficientOutput` | The pool is too thin for the size. Lower the size ("trade smaller") or set `MIN_TRADE`. |
| `NoLiquidity` / quote reverts | Wrong fee tier, or no pool for the pair. Fix it with `setFee` on the V3 adapter. |
| Indicators "warming up" | They need 25 price samples (`LOOP_MS` × 25). History persists in `agent/data/`. |
| `--verify` fails | Deploy without `--verify`, then run `forge verify-contract` with the blockscout flags. |
