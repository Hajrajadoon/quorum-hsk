# Submission kit

**Deadline: December 3, 2026, 13:00 KST = 09:00 Pakistan time (PKT) = 04:00 UTC.**
Late submissions are rejected and the system closes automatically. Aim to submit on **Dec 2, evening PKT**.

## Copy-paste texts

**Project name:** QUORUM

**Track:** AI Agent Trading

**Tagline (≤ 100 chars):** An AI trading council on HSK Chain that can't go rogue: quorum votes, on-chain guardrails, proof of reasoning.

**Short description:**
QUORUM is an autonomous trading agent for HSKSwap. Three AI agents debate every trade: a momentum quant, a contrarian/arbitrageur and a risk officer with a hard veto. A trade only happens when they reach a quorum. The agent's key lives inside QuorumVault on HSK Chain mainnet. It can trade, but it can never withdraw. Max trade size, max position, slippage, cooldown, trade frequency and a daily-loss circuit breaker are all enforced on-chain. Every decision's full reasoning transcript is hashed with keccak256 and committed on-chain inside the trade transaction, so anyone can verify why the AI traded. Users control it in plain language ("be more conservative", "only trade HSK", "why did you sell?"). Policy changes require the owner's wallet signature, so the AI can never loosen its own limits.

**How it meets the track requirements:**
- Monitors markets and on-chain data: HSKSwap quotes, a reference price, and indicators (EMA, RSI, z-score, volatility regime).
- Arbitrage and spread opportunities: DEX-vs-reference spread detection (Nyx).
- Autonomous execution: an agent loop with quorum voting that executes via HSKSwap adapters.
- Strict risk controls and stop-loss: on-chain policy plus a daily-loss circuit breaker, stop-loss and take-profit.
- Conversational interface: real-time positions and PnL, plus control of size, frequency, risk appetite and target assets.

**Tech:** Solidity (Foundry), Node.js + ethers v6, OpenAI-compatible LLMs (optional), zero-build dashboard, keccak256 proof-of-reasoning.

**Links to fill in:** GitHub repo · mainnet vault address · Blockscout link to the verified contract · one trade tx · demo video (2–3 min) · deck

## Final checklist

- [ ] Contracts deployed on **HSK Chain mainnet** and verified on Blockscout (mandatory for prize eligibility)
- [ ] At least a few **real trades** visible on the explorer (DeployDemo venue and/or real HSKSwap)
- [ ] GitHub repo public, with the README at the root and no `.env` files committed (`git status` before pushing)
- [ ] Demo video recorded (screen + voice, follow docs/PITCH.md)
- [ ] Submitted before Dec 3, 09:00 PKT
- [ ] In the form, mark that you can pitch **in person in Seoul** if possible (priority for demo selection), or be online at your assigned slot

## 6-day plan (today = Mon Nov 23)

| Day | Goal | Done when |
|---|---|---|
| **Tue 24** | Run everything locally: `npm run demo`, `npm test`, `forge test`. Read the code and make the pitch yours. | All tests green, dashboard running on your machine |
| **Wed 25** | Testnet dry run (chain 133): DeployDemo, `npm run live`, see trades on the testnet explorer | Live trades on testnet |
| **Thu 26** | **Mainnet**: DeployDemo + verify. Agent live. Optionally set an LLM key. | Vault verified on Blockscout, trades flowing |
| **Fri 27** | Real HSKSwap path: find the router/quoter, deploy `Deploy.s.sol` with ~$10–20 USDT, run 1–2 real trades | One real HSKSwap trade tx link |
| **Sat 28** | Polish: push to GitHub, write the deck (5 slides), rehearse the pitch 3× | Repo public, deck done |
| **Sun 29 – Mon 30** | Record the 2–3 min demo video, buffer for bugs | Video uploaded |
| **Tue Dec 1 – Wed Dec 2** | **Submit** (do not wait for Dec 3) | Confirmation email |
| Thu Dec 4 | Pitch selections announced, so watch your email | |
| Sat Dec 5 | Demo Day, Seoul | |

## Security reminders

- Never commit `.env`. The repo's `.gitignore` already excludes it.
- The organizers never charge fees. Ignore DMs asking for payments or "verification".
- Keep only small amounts in the demo vault.
