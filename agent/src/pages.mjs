// Built-in, read-only transaction and vault pages. They read straight from the chain through the
// agent's RPC connection, so judges can inspect every trade even when no block explorer is online.
import { keccak256Utf8 } from './core/keccak.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (x, d = 6) => (Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-US', { maximumFractionDigits: d }) : esc(x));
const signed = (x) => `${Number(x) > 0 ? '+' : ''}${num(x, 4)}`;

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · QUORUM</title>
<style>
:root{--bg:#060a13;--panel:#0e1424;--line:#1b2438;--text:#e8edf7;--muted:#8a94aa;--green:#22d3a0;--red:#ff5c7a;--amber:#ffb547;--cyan:#3fd5ff;--mono:ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 10% -10%,rgba(91,140,255,.15),transparent 60%),var(--bg);color:var(--text);font:14px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 60px}a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:22px;margin:6px 0 4px}.muted{color:var(--muted)}.mono{font-family:var(--mono);word-break:break-all}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:16px}
.card h2{margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted)}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px;width:190px}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-weight:700;font-size:12px;font-family:var(--mono);border:1px solid var(--line)}
.ok{color:var(--green);border-color:rgba(34,211,160,.5)}.bad{color:var(--red);border-color:rgba(255,92,122,.5)}.warn{color:var(--amber);border-color:rgba(255,181,71,.5)}
.check{padding:12px 14px;border-radius:12px;margin-top:10px}.check.ok{background:rgba(34,211,160,.08);border:1px solid rgba(34,211,160,.45)}.check.bad{background:rgba(255,92,122,.08);border:1px solid rgba(255,92,122,.45)}
pre{background:#070c18;border:1px solid var(--line);border-radius:10px;padding:12px;font-size:12px;overflow:auto;max-height:340px;color:#c8d3ea;white-space:pre-wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.3em}
</style></head><body><div class="wrap">
<div class="brand"><svg width="28" height="28" viewBox="0 0 40 40"><circle cx="12" cy="25" r="8" fill="#5B8CFF"/><circle cx="28" cy="25" r="8" fill="#C17BFF"/><circle cx="20" cy="12" r="8" fill="#22D3A0"/><circle cx="20" cy="21" r="3" fill="#060a13"/></svg>QUORUM <span class="muted" style="letter-spacing:0;font-weight:500">· on-chain viewer</span> <a href="/" style="margin-left:auto;letter-spacing:0;font-weight:500">← Dashboard</a></div>
${body}
<p class="muted" style="margin-top:24px;font-size:12px">Read live from the chain through the agent's RPC connection. No block explorer needed.</p>
</div></body></html>`;
}

/**
 * @param {object|null} tx    result of vault.txDetails()
 * @param {object|null} decision  the agent's stored decision for this tx (with json), if any
 */
export function renderTxPage(hash, tx, decision) {
  if (!tx) {
    return layout('Transaction', `<div class="card"><h1>Transaction not found</h1><p class="mono">${esc(hash)}</p><p class="muted">It may still be pending, or it belongs to another network.</p></div>`);
  }
  if (tx.simulated) {
    return layout('Simulated transaction', `<div class="card"><h1>Simulated transaction</h1><p class="mono">${esc(hash)}</p><p class="muted">This dashboard is running in simulation mode. Run the agent with <span class="mono">npm run live</span> to see real HSK Chain transactions here.</p></div>`);
  }
  const status = `<span class="pill ${tx.status === 'success' ? 'ok' : tx.status === 'failed' ? 'bad' : 'warn'}">${esc(tx.status.toUpperCase())}</span>`;
  const rows = [
    ['Transaction hash', `<span class="mono">${esc(tx.hash)}</span>`],
    ['Status', status],
    ['Network', `${esc(tx.network)} (chain ${esc(tx.chainId)})`],
    ['Block', esc(tx.blockNumber ?? '–')],
    ['From', `<span class="mono">${esc(tx.from)}</span>`],
    ['To', `<span class="mono">${esc(tx.to)}</span>${tx.method ? ` · <b>${esc(tx.method)}()</b>` : ''}`],
    ['Gas used', esc(tx.gasUsed ?? '–')],
  ];
  let proof = '';
  const trade = tx.events.find((e) => e.name === 'TradeExecuted');
  const attested = tx.events.find((e) => e.name === 'DecisionAttested');
  const onchainHash = trade?.reasoningHash ?? attested?.args?.reasoningHash ?? null;
  if (onchainHash) {
    let verdict = `<div class="check bad">The agent no longer has the reasoning record for this transaction in memory, so it can't be re-hashed here. The on-chain hash is permanent; the record is in <span class="mono">agent/data/proofs-live.jsonl</span>.</div>`;
    let pretty = '';
    if (decision?.json) {
      const recomputed = keccak256Utf8(decision.json);
      const ok = recomputed.toLowerCase() === String(onchainHash).toLowerCase();
      verdict = `<div class="check ${ok ? 'ok' : 'bad'}">${ok ? '✅ <b>Proof of reasoning verified.</b> The hash stored on-chain in this transaction equals the keccak256 of the council transcript below.' : '❌ <b>Mismatch</b> between the on-chain hash and the stored record.'}</div>
        <table style="margin-top:8px"><tr><th>On-chain hash</th><td class="mono">${esc(onchainHash)}</td></tr><tr><th>Recomputed from record</th><td class="mono">${esc(recomputed)}</td></tr></table>`;
      try {
        pretty = `<pre>${esc(JSON.stringify(JSON.parse(decision.json), null, 2))}</pre>`;
      } catch {
        pretty = `<pre>${esc(decision.json)}</pre>`;
      }
    }
    proof = `<div class="card"><h2>Proof of reasoning</h2>${verdict}${pretty}</div>`;
  }
  const evRows = tx.events
    .map((e) => {
      if (e.name === 'TradeExecuted') {
        return `<tr><th>TradeExecuted #${esc(e.tradeId)}</th><td><span class="pill ${e.side === 'BUY' ? 'ok' : 'bad'}">${esc(e.side)}</span> ${esc(e.token)} · in ${num(e.amountIn)} ${esc(e.amountInSymbol)} → out ${num(e.amountOut)} ${esc(e.amountOutSymbol)}${e.side === 'SELL' ? ` · PnL ${signed(e.pnl)}` : ''} · votes ${esc(e.votes)}/3<br><span class="muted">reasoning hash</span> <span class="mono">${esc(e.reasoningHash)}</span></td></tr>`;
      }
      if (e.name === 'Transfer') {
        return `<tr><th>Transfer</th><td>${num(e.amount)} ${esc(e.token)} · <span class="mono">${esc(e.from)}</span> → <span class="mono">${esc(e.to)}</span></td></tr>`;
      }
      if (e.args) {
        return `<tr><th>${esc(e.name)}</th><td class="mono">${Object.entries(e.args).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>')}</td></tr>`;
      }
      return `<tr><th>${esc(e.name)}</th><td class="mono">${esc(e.contract ?? '')}</td></tr>`;
    })
    .join('');
  const body = `<h1 style="margin-top:22px">Transaction</h1>
    <div class="card"><h2>Overview</h2><table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>
    ${proof}
    <div class="card"><h2>Events</h2><table>${evRows || '<tr><td class="muted">No events.</td></tr>'}</table></div>`;
  return layout('Transaction', body);
}

export function renderVaultPage(v) {
  if (!v) return layout('Vault', '<div class="card"><h1>Vault details are only available in live mode.</h1></div>');
  const p = v.policy;
  const s = v.snap;
  const pos = v.positions
    .map((x) => `<tr><td><b>${esc(x.symbol)}</b></td><td>${num(x.balance)}</td><td>${num(x.cost, 2)} ${esc(v.base.symbol)}</td><td>${x.allowed ? '<span class="pill ok">allowed</span>' : '<span class="pill warn">not allowed</span>'}</td></tr>`)
    .join('');
  const trades = v.trades
    .map((t) => `<tr><td>#${esc(t.id)}</td><td><span class="pill ${t.side === 'BUY' ? 'ok' : 'bad'}">${esc(t.side)}</span> ${esc(t.token)}</td><td>${t.side === 'SELL' ? signed(t.pnl) : '–'}</td><td>${t.votes == null ? '–' : esc(t.votes) + '/3'}</td><td><a class="mono" href="/tx/${esc(t.txHash)}">${esc(t.txHash.slice(0, 12))}…</a></td></tr>`)
    .join('');
  const body = `<h1 style="margin-top:22px">QuorumVault</h1><div class="mono muted">${esc(v.address)} · ${esc(v.network)} (chain ${esc(v.chainId)})</div>
    <div class="card"><h2>Roles</h2><table>
      <tr><th>Owner (can withdraw, set policy, pause)</th><td class="mono">${esc(v.owner)}</td></tr>
      <tr><th>Agent (trade only, never withdraw)</th><td class="mono">${esc(v.agent)}</td></tr>
      <tr><th>Swap adapter</th><td class="mono">${esc(v.adapter)}</td></tr>
      <tr><th>Base asset</th><td>${esc(v.base.symbol)} <span class="mono muted">${esc(v.base.address)}</span></td></tr>
      <tr><th>Status</th><td>${v.paused ? '<span class="pill bad">PAUSED (kill switch)</span>' : s.halted ? '<span class="pill warn">BUYS HALTED (circuit breaker)</span>' : '<span class="pill ok">ACTIVE</span>'}</td></tr>
    </table></div>
    <div class="card"><h2>Live state</h2><table>
      <tr><th>Cash</th><td>${num(s.baseBalance, 2)} ${esc(v.base.symbol)}</td></tr>
      <tr><th>Cost basis in positions</th><td>${num(s.totalCostBasis, 2)} ${esc(v.base.symbol)}</td></tr>
      <tr><th>Realized PnL (all time)</th><td>${signed(s.realizedPnlTotal)} ${esc(v.base.symbol)}</td></tr>
      <tr><th>Loss today / day-start equity</th><td>${num(s.realizedLossToday, 2)} / ${num(s.dayStartEquity, 2)}</td></tr>
      <tr><th>Buys today</th><td>${esc(s.buysToday)} / ${esc(p.maxTradesPerDay)}</td></tr>
      <tr><th>Trades executed</th><td>${esc(s.tradeCount)}</td></tr>
    </table></div>
    <div class="card"><h2>On-chain policy</h2><table>
      <tr><th>Max trade</th><td>${p.maxTradeBps / 100}% of cash</td></tr><tr><th>Max position</th><td>${p.maxPositionBps / 100}% of equity</td></tr>
      <tr><th>Max slippage</th><td>${p.maxSlippageBps / 100}%</td></tr><tr><th>Daily loss breaker</th><td>${p.maxDailyLossBps / 100}%</td></tr>
      <tr><th>Stop-loss / take-profit</th><td>${p.stopLossBps / 100}% / ${p.takeProfitBps / 100}%</td></tr>
      <tr><th>Cooldown · buys per day</th><td>${p.cooldown}s · ${p.maxTradesPerDay}</td></tr><tr><th>Quorum</th><td>${p.quorum} of 3</td></tr>
    </table></div>
    <div class="card"><h2>Positions</h2><table><tr><th>Asset</th><th>Balance</th><th>Cost basis</th><th>Whitelist</th></tr>${pos || '<tr><td class="muted">None</td></tr>'}</table></div>
    <div class="card"><h2>Recent trades ${v.tradesSource === 'agent' ? '(transactions recorded by the agent)' : '(from on-chain events)'}</h2><table><tr><th>ID</th><th>Side</th><th>PnL</th><th>Votes</th><th>Transaction</th></tr>${trades || '<tr><td class="muted" colspan="5">No trades yet.</td></tr>'}</table></div>`;
  return layout('Vault', body);
}
