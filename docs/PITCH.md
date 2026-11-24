# QUORUM: 3-minute pitch + live demo script

**One-liner:** *"QUORUM is an AI trading council on HSK Chain. Three agents debate every trade. A smart contract makes sure that even when they agree, they can't break your rules. And you can verify every decision they ever made."*

## Before you go on stage (checklist)

- [ ] `npm run live` has been running for 15+ minutes (indicators warm, a few trades already on the chart)
- [ ] MetaMask is connected as the owner on HSK Chain mainnet, with a little HSK for gas
- [ ] One Blockscout tab is open on a vault trade transaction
- [ ] Backup: `agent/dist/quorum-demo.html` is open in a second tab (works offline, no RPC, no AI key)
- [ ] Browser zoom is 90% so the whole dashboard fits on the projector

## Script (≈3:00)

**0:00 · The problem (20s)**
> "Everyone is building AI trading agents. But to use one, you hand an AI your private key. One hallucination, one prompt injection, one leaked key, and your funds are gone. Would you give an LLM your wallet?"

**0:20 · The idea (25s)**
> "QUORUM fixes trust in three layers. First, no single AI decides. Atlas trades momentum, Nyx hunts arbitrage between HSKSwap and the reference price, and Sentinel is the risk officer with a veto. A trade needs a quorum. Second, the AI's key only has the permissions a vault contract on HSK Chain gives it. It can trade inside your risk policy, but it can never withdraw. Third, every decision is hashed on-chain: proof of reasoning."

**0:45 · Live demo: the council (35s)** *(point at the council chamber)*
> "This is live on HSK Chain mainnet. Every tick, the council debates. Here Atlas says the uptrend is confirmed, Nyx sees HSKSwap trading 0.8% below reference, and Sentinel approves the risk. That's 2 of 3, quorum reached, BUY. Here's the transaction on Blockscout."

**1:20 · Proof of reasoning (30s)** *(click Verify ✓ on a trade)*
> "Click Verify. My browser re-hashes the full transcript and gets the same hash the vault emitted in that trade. Now watch: I change a single vote. The hash breaks. Nobody can rewrite why the AI traded, not even us. For regulated finance, that audit trail is the product."

**1:50 · Chat + guardrails (40s)** *(type in the chat)*
> "Users talk to it. 'Be more conservative.' The agent *proposes* the policy change, but only my owner wallet can sign it, because the agent cannot loosen its own limits." *(sign in MetaMask)* "Quorum is now 3 of 3, max trade 5%, stop-loss 2%, all enforced by the contract.
> If the agent goes rogue and tries to buy too much, the vault reverts. If we lose 5% in a day, an on-chain circuit breaker halts buys. And this is the kill switch."* (click it, show VAULT PAUSED, release)

**2:30 · Why it wins (25s)**
> "Most trading bots ask you to trust the bot. QUORUM asks you to trust math. It's built for HSK Chain's compliance-first vision: AI that can be audited. Next: HSP payments so the council can buy signals from third-party agents, and ERC-4626 shares so anyone can join a vault."

**2:55 · Close**
> "QUORUM: AI that can't go rogue. Thank you."

## Likely judge questions

| Q | A |
|---|---|
| Is the stop-loss on-chain? | The **daily-loss circuit breaker** is fully on-chain and uses realized PnL, so no oracle is needed. Stop-loss and take-profit thresholds live on-chain. The agent triggers them from venue quotes, and exits can never be blocked. An oracle-based on-chain stop is on the roadmap (Supra/Chainlink are both on HSK Chain). |
| Can the agent fake the votes? | The vault enforces the vote count the agent reports. That count is bound to the hashed transcript, so any discrepancy is publicly provable. A ZK or TEE attestation is the next step. |
| What if the LLM is wrong or down? | Every agent has a deterministic quant model. The LLM reasons on top of it, and bad output falls back to the model. The veto is never delegated to the LLM. |
| Why HSKSwap liquidity? | Real HSKSwap V3 adapter + a demo venue for stage reliability, because mainnet liquidity is thin. Same vault, same guardrails. Switching is `setAdapter`. |
| Is it profitable? | We don't claim alpha. We claim **safe autonomy**: whatever strategy runs inside QUORUM, it cannot exceed the owner's risk budget. The strategies are pluggable. |
| Why 3 agents and not 1? | It's ensemble decision-making: independent mandates reduce correlated errors, and the risk officer is structurally separated from the profit-seekers, the same way trading desks separate risk from trading. |
| Gas cost? | One trade = one tx. The reasoning hash is 32 bytes riding in the same transaction: a few hundred extra gas, which is negligible on HSK Chain. |

## Slide outline (5 slides max)

1. **Title**: QUORUM · An AI trading council that can't go rogue · logo with three circles
2. **Problem**: "Would you give an LLM your private key?" + three failure modes (hallucination, injection, key theft)
3. **Solution**: council → guardrail vault → proof of reasoning (use the README diagram)
4. **Live demo** (switch to the dashboard)
5. **Why it matters for HSK Chain**: auditable AI for compliant finance · roadmap (HSP signal payments, ERC-4626, oracle stops) · team
