// QUORUM dashboard. Talks to the agent over HTTP + SSE, or to an in-browser engine
// (standalone demo) through the same tiny API surface.
import { keccak256Utf8 } from '../src/core/keccak.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const token = new URLSearchParams(location.search).get('token') || '';

// ------------------------------------------------------------------ API
function httpApi() {
  const headers = { 'content-type': 'application/json', ...(token ? { 'x-quorum-token': token } : {}) };
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  return {
    connect(onEvent) {
      let es;
      const open = () => {
        es = new EventSource('/api/events');
        for (const t of ['state', 'decision', 'trade', 'thinking']) es.addEventListener(t, (e) => onEvent(t, JSON.parse(e.data)));
        es.onerror = () => {
          showBanner('Connection to the agent lost. Retrying…');
          es.close();
          setTimeout(open, 2000);
        };
        es.onopen = () => hideBanner();
      };
      open();
    },
    getDecision: async (id) => {
      const r = await fetch(`/api/decision/${id}`);
      if (!r.ok) throw new Error('decision not found');
      return r.json();
    },
    chat: (text) => post('/api/chat', { text }),
    owner: (method, arg) => post('/api/owner', { method, arg }),
    refresh: () => post('/api/refresh', {}),
  };
}
const API = window.QUORUM_API || httpApi();

// ------------------------------------------------------------------ formatting
const usd = (x, d = 2) => {
  const v = Number(x) || 0;
  return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const signed = (x, f = usd) => ((Number(x) || 0) > 0 ? '+' : '') + f(x);
const pct = (x, d = 2) => `${(Number(x) || 0) > 0 ? '+' : ''}${(Number(x) || 0).toFixed(d)}%`;
const price = (x) => {
  const v = Number(x) || 0;
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 4 : 5, minimumFractionDigits: v >= 100 ? 2 : 4 });
};
const amt = (x) => {
  const v = Number(x) || 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 2 : v >= 1 ? 4 : 6 });
};
const short = (h, a = 6, b = 4) => (h ? `${h.slice(0, a)}…${h.slice(-b)}` : '—');
const clock = (t) => (t ? new Date(t * 1000).toISOString().slice(11, 19) : '');
const cls = (x) => ((Number(x) || 0) >= 0 ? 'up' : 'down');

// ------------------------------------------------------------------ state
let S = null;
let symbol = null;
let feedFilter = 'all';
let lastDecisionId = 0;
let lastChatLen = 0;
let ownerAccount = null;

const AVATARS = {
  atlas: (c) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16l8-8 8 8"/><path d="M4 21l8-8 8 8" opacity=".45"/></svg>`,
  nyx: (c) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>`,
  sentinel: (c) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke-linecap="round"/></svg>`,
};

// ------------------------------------------------------------------ render
function render() {
  if (!S) return;
  if (!symbol || !S.info.symbols.includes(symbol)) symbol = S.info.symbols[0];
  renderHeader();
  renderKpis();
  renderTabs();
  drawChart();
  renderFeatures();
  renderCouncil();
  renderFeed();
  renderGuardrails();
  renderPositions();
  renderChat();
}

function renderHeader() {
  const live = S.mode === 'live';
  $('netName').textContent = live ? `${S.info.network} · ${S.info.chainId}` : 'Simulation · HSK Chain replica';
  const vaultEl = $('vaultAddr');
  if (live) {
    const href = S.info.explorer ? `${esc(S.info.explorer)}/address/${esc(S.info.vault)}` : '/vault';
    vaultEl.innerHTML = `<a href="${href}" target="_blank" rel="noopener">${short(S.info.vault)}</a>`;
  } else vaultEl.textContent = short(S.info.vault);
  const pill = $('statusPill');
  pill.className = `pill status-${S.statusCode}`;
  $('statusText').textContent = { live: 'COUNCIL LIVE', standby: 'STANDING DOWN', halted: 'BUYS HALTED', paused: 'VAULT PAUSED' }[S.statusCode] ?? S.status;
  const kill = $('killBtn');
  kill.classList.toggle('on', !!S.snap.paused);
  const killIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" style="vertical-align:-2px;margin-right:6px"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>';
  kill.innerHTML = killIcon + (S.snap.paused ? 'Release kill switch' : 'Kill switch');
  $('walletBtn').style.display = live ? '' : 'none';
  $('llmTag').textContent = S.llm ? 'LLM council + quant guardrails' : 'quant models (no LLM key)';
  $('footInfo').textContent = `${S.mode.toUpperCase()} · tick ${S.stats.ticks} · ${clock(S.now)} UTC${S.lastError ? ' · last error: ' + S.lastError : ''}`;
}

function renderKpis() {
  // gain on the capital put in = realized + unrealized PnL (consistent with the Total PnL card)
  const gain = S.pnl.total;
  const capitalIn = (S.snap.baseBalance ?? 0) + (S.snap.totalCostBasis ?? 0) - (S.pnl.realized ?? 0);
  const gainPct = capitalIn > 0 ? (gain / capitalIn) * 100 : 0;
  $('kEquity').textContent = usd(S.equity);
  $('kEquitySub').innerHTML = `<span class="${cls(gain)}">${signed(gain)} (${pct(gainPct)})</span> on capital`;
  $('kPnl').innerHTML = `<span class="${cls(S.pnl.total)}">${signed(S.pnl.total)}</span>`;
  $('kPnlSub').innerHTML = `realized <span class="${cls(S.pnl.realized)}">${signed(S.pnl.realized)}</span> · open <span class="${cls(S.pnl.unrealized)}">${signed(S.pnl.unrealized)}</span>`;
  const sells = S.trades.filter((t) => t.side === 'SELL');
  const wins = sells.filter((t) => t.pnl > 0).length;
  $('kTrades').textContent = S.stats.trades;
  $('kTradesSub').textContent = sells.length ? `win rate ${Math.round((wins / sells.length) * 100)}% (${wins}/${sells.length} exits)` : 'no exits yet';
  $('kVeto').textContent = `${S.stats.vetoes} · ${S.stats.blocked}`;
  $('kProofs').textContent = S.stats.proofs;
  $('kBuys').textContent = `${S.snap.buysToday ?? 0}/${S.policy.maxTradesPerDay ?? '—'}`;
  $('kBuysSub').textContent = `quorum ${S.policy.quorum ?? '—'} of 3`;
  drawSpark();
}

function renderTabs() {
  const el = $('symTabs');
  const html = S.info.symbols.map((s) => `<button class="tab ${s === symbol ? 'active' : ''}" data-sym="${esc(s)}">${esc(s)}</button>`).join('');
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawChart() {
  const canvas = $('chart');
  const { ctx, w, h } = setupCanvas(canvas);
  const data = S.history[symbol] ?? [];
  if (data.length < 2) {
    ctx.fillStyle = '#8a94aa';
    ctx.font = '13px sans-serif';
    ctx.fillText('Collecting prices…', 16, 28);
    return;
  }
  const pad = { l: 8, r: 64, t: 14, b: 22 };
  const vals = [];
  for (const [, p, r] of data) {
    vals.push(p);
    if (r != null) vals.push(r);
  }
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = hi - lo || hi * 0.01 || 1;
  lo -= span * 0.08;
  hi += span * 0.08;
  const t0 = data[0][0];
  const t1 = data[data.length - 1][0];
  const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);

  // grid + axis labels
  ctx.strokeStyle = 'rgba(138,148,170,0.10)';
  ctx.fillStyle = '#6b7690';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = Y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(price(v), w - pad.r + 6, y + 4);
  }

  // reference (dashed)
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(160,170,195,0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let started = false;
  for (const [t, , r] of data) {
    if (r == null) continue;
    if (!started) {
      ctx.moveTo(X(t), Y(r));
      started = true;
    } else ctx.lineTo(X(t), Y(r));
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // DEX price with gradient fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, 'rgba(63,213,255,0.28)');
  grad.addColorStop(1, 'rgba(63,213,255,0)');
  ctx.beginPath();
  data.forEach(([t, p], i) => (i ? ctx.lineTo(X(t), Y(p)) : ctx.moveTo(X(t), Y(p))));
  ctx.lineTo(X(t1), h - pad.b);
  ctx.lineTo(X(t0), h - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  data.forEach(([t, p], i) => (i ? ctx.lineTo(X(t), Y(p)) : ctx.moveTo(X(t), Y(p))));
  ctx.strokeStyle = '#3fd5ff';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(63,213,255,0.6)';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // last price tag
  const last = data[data.length - 1];
  const ly = Y(last[1]);
  ctx.fillStyle = '#3fd5ff';
  ctx.beginPath();
  ctx.arc(X(last[0]), ly, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(63,213,255,0.16)';
  ctx.fillRect(w - pad.r + 2, ly - 9, pad.r - 4, 18);
  ctx.fillStyle = '#bfefff';
  ctx.fillText(price(last[1]), w - pad.r + 6, ly + 4);

  // trade markers
  for (const tr of S.trades) {
    if (tr.symbol !== symbol || tr.t < t0) continue;
    const x = X(tr.t);
    const y = Y(tr.price);
    const buy = tr.side === 'BUY';
    ctx.fillStyle = buy ? '#22d3a0' : '#ff5c7a';
    ctx.strokeStyle = '#060a13';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (buy) {
      ctx.moveTo(x, y + 4);
      ctx.lineTo(x - 7, y + 15);
      ctx.lineTo(x + 7, y + 15);
    } else {
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x - 7, y - 15);
      ctx.lineTo(x + 7, y - 15);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  $('chartInfo').textContent = `· ${data.length} ticks · ${S.mode === 'sim' ? '1 tick = 1 simulated minute' : 'live quotes'}`;
}

function drawSpark() {
  const canvas = $('spark');
  const { ctx, w, h } = setupCanvas(canvas);
  const pts = S.equityCurve;
  if (pts.length < 2) return;
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const X = (i) => (i / (pts.length - 1)) * w;
  const Y = (v) => h - 3 - ((v - lo) / (hi - lo || 1)) * (h - 6);
  const up = vals[vals.length - 1] >= vals[0];
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = up ? '#22d3a0' : '#ff5c7a';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function renderFeatures() {
  const d = S.decisions.find((x) => x.symbol === symbol && x.agents);
  const hist = S.history[symbol] ?? [];
  const last = hist[hist.length - 1];
  const spread = last && last[2] ? ((last[2] - last[1]) / last[1]) * 10000 : null;
  const pos = S.positions.find((p) => p.symbol === symbol);
  const items = [
    ['Price', last ? price(last[1]) : '—'],
    ['Ref', last && last[2] ? price(last[2]) : '—'],
    ['Spread', spread == null ? '—' : `<span class="${spread > 60 ? 'up' : spread < -60 ? 'down' : ''}">${spread.toFixed(0)} bps</span>`],
    ['Position', pos && pos.balance > 0 ? amt(pos.balance) : 'flat'],
    ['Open PnL', pos && pos.balance > 0 ? `<span class="${cls(pos.pnlPct)}">${pct(pos.pnlPct)}</span>` : '—'],
    ['Last verdict', d ? `<span class="chip ${d.action}">${d.action}</span>` : '—'],
  ];
  $('feat').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}

function renderCouncil() {
  const card = $('councilCard');
  const thinking = !!S.thinking;
  card.classList.toggle('thinking', thinking);
  const d = S.decisions[0];
  $('councilMeta').textContent = thinking ? `deliberating on ${S.thinking.symbol}…` : d ? `#${d.id} · ${d.symbol} · ${clock(d.t)}` : '';
  const v = $('verdict');
  if (d) {
    const color = { BUY: 'var(--green)', SELL: 'var(--red)', VETO: 'var(--amber)', BLOCKED: 'var(--amber)' }[d.action] ?? '#9aa6bf';
    const isNew = v.dataset.id !== String(d.id);
    v.className = `verdict ${d.action}${isNew && d.action !== 'HOLD' ? ' flash' : ''}`;
    v.dataset.id = d.id;
    const dots = [0, 1, 2].map((i) => `<i class="${i < d.votes ? 'on' : ''}"></i>`).join('');
    v.innerHTML = `<div class="act">${d.action}</div><div class="txt"><b style="color:var(--text)">${esc(d.symbol)} @ ${price(d.price)}</b> · ${d.trigger !== 'COUNCIL' ? esc(d.trigger.replace('_', ' ')) + ' · ' : ''}votes ${d.votes}/3 · quorum ${d.quorum}<br>${esc(d.summary)}</div><div class="ballot" style="color:${color}" title="votes">${dots}</div>`;
  }
  const agents = d?.agents ?? S.council.map((c) => ({ ...c, stance: 'HOLD', confidence: 0, rationale: 'Waiting for market data…' }));
  $('agents').innerHTML = agents
    .map((a) => {
      const c = a.color;
      const stance = a.veto ? 'VETO' : a.stance;
      return `<div class="agent" style="--c:${c}">
        <div class="av">${(AVATARS[a.id] ?? AVATARS.atlas)(c)}</div>
        <div>
          <div class="nm"><b>${esc(a.name)}</b><small>${esc(a.role)}</small><span class="stance ${stance}">${stance}</span></div>
          <p>${esc(a.rationale)}</p>
          <div class="conf"><div style="width:${Math.round((a.confidence || 0) * 100)}%"></div></div>
          <div class="src">confidence ${Math.round((a.confidence || 0) * 100)}% · ${a.source === 'llm' ? 'LLM reasoning' : a.source === 'policy' ? 'owner policy' : 'quant model'}</div>
        </div></div>`;
    })
    .join('');
}

function decisionCard(d, isNew) {
  const compact = d.action === 'HOLD';
  const tx = d.txHash
    ? d.explorer
      ? `<a href="${esc(d.explorer)}" target="_blank" rel="noopener">tx ${short(d.txHash)}</a>`
      : `<span title="simulated transaction">tx ${short(d.txHash)}</span>`
    : `<span>${esc(d.status)}</span>`;
  const result =
    d.status === 'executed' && d.result
      ? d.action === 'BUY'
        ? ` · spent ${usd(d.sizing.amountIn)} → ${amt(d.result.amountOut)} ${esc(d.symbol)}`
        : ` · ${amt(d.sizing.amountIn)} ${esc(d.symbol)} → ${usd(d.result.amountOut)} <span class="${cls(d.result.pnl)}">(${signed(d.result.pnl)})</span>`
      : d.status === 'rejected'
        ? ` · <span class="down">rejected: ${esc(d.error)}</span>`
        : '';
  const dots = [0, 1, 2].map((i) => (i < d.votes ? '●' : '○')).join('');
  return `<div class="dec ${compact ? 'compact' : ''} ${isNew ? 'new' : ''}">
    <div class="row1"><span class="chip ${d.action}">${d.action}</span><b>${esc(d.symbol)}</b><span class="mono muted">${price(d.price)}</span>
      ${d.trigger !== 'COUNCIL' ? `<span class="trig ${esc(d.trigger)}">${esc(d.trigger.replace('_', ' '))}</span>` : ''}
      <span class="mono dim" title="votes">${dots}</span><span class="mono dim" style="margin-left:auto">#${d.id} · ${clock(d.t)}</span></div>
    <div class="summary">${esc(d.summary)}${result}</div>
    <div class="row2"><span class="mono" title="${esc(d.reasoningHash)}">🔗 ${short(d.reasoningHash, 10, 6)}</span>${tx}<button class="vbtn" data-verify="${d.id}">Verify ✓</button></div>
  </div>`;
}

function renderFeed() {
  let list = S.decisions;
  if (feedFilter === 'trades') list = list.filter((d) => d.status === 'executed');
  if (feedFilter === 'risk') list = list.filter((d) => d.action === 'VETO' || d.action === 'BLOCKED' || d.trigger === 'STOP_LOSS');
  const top = S.decisions[0]?.id ?? 0;
  const key = `${feedFilter}:${top}:${list.length}`;
  const el = $('feed');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = list.length
    ? list.slice(0, 30).map((d) => decisionCard(d, d.id > lastDecisionId && lastDecisionId > 0)).join('')
    : '<div class="muted" style="padding:12px">Nothing here yet.</div>';
  lastDecisionId = top;
}

function rail(id, frac, text, invert = false) {
  const f = Math.max(0, Math.min(1, frac));
  $(id).textContent = text;
  const bar = $(id + 'Bar');
  bar.className = 'bar' + (invert ? '' : f > 0.85 ? ' bad' : f > 0.6 ? ' warn' : '');
  bar.firstElementChild.style.width = `${(f * 100).toFixed(1)}%`;
}

function renderGuardrails() {
  const p = S.policy;
  const s = S.snap;
  const limit = (s.dayStartEquity * p.maxDailyLossBps) / 10000;
  rail('gLoss', limit > 0 ? s.realizedLossToday / limit : 0, `${usd(s.realizedLossToday)} / ${usd(limit)}${s.halted ? ' · HALTED' : ''}`);
  rail('gBuys', p.maxTradesPerDay ? s.buysToday / p.maxTradesPerDay : 0, `${s.buysToday}/${p.maxTradesPerDay}`);
  const nowSec = S.mode === 'live' ? Math.floor(Date.now() / 1000) : S.now;
  const left = s.lastBuyAt ? Math.max(0, Math.min(p.cooldown, s.lastBuyAt + p.cooldown - nowSec)) : 0;
  rail('gCool', p.cooldown ? 1 - left / p.cooldown : 1, left > 0 ? `${left}s left` : 'ready', true);
  const eqCost = s.baseBalance + s.totalCostBasis;
  $('exposure').innerHTML = S.positions
    .map((pos) => {
      const used = eqCost > 0 ? pos.cost / eqCost / (p.maxPositionBps / 10000) : 0;
      const f = Math.max(0, Math.min(1, used));
      return `<div class="rail"><div class="lbl"><span>${esc(pos.symbol)} exposure vs ${p.maxPositionBps / 100}% cap</span><b>${((pos.cost / (eqCost || 1)) * 100).toFixed(1)}%</b></div><div class="bar ${f > 0.85 ? 'bad' : f > 0.6 ? 'warn' : ''}"><div style="width:${(f * 100).toFixed(1)}%"></div></div></div>`;
    })
    .join('');
  const items = [
    ['Max trade', `${p.maxTradeBps / 100}%`],
    ['Max position', `${p.maxPositionBps / 100}%`],
    ['Stop-loss', `${p.stopLossBps / 100}%`],
    ['Take-profit', `${p.takeProfitBps / 100}%`],
    ['Max slippage', `${p.maxSlippageBps / 100}%`],
    ['Loss breaker', `${p.maxDailyLossBps / 100}%/day`],
    ['Cooldown', `${p.cooldown}s`],
    ['Quorum', `${p.quorum} of 3`],
  ];
  $('policy').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  $('presetName').textContent = `${S.preset} · sizing ${Math.round(S.prefs.sizeMultiplier * 100)}%`;
  for (const b of document.querySelectorAll('.preset')) b.classList.toggle('active', b.dataset.preset === S.preset);
}

function renderPositions() {
  const rows = S.positions.map(
    (p) => `<tr><td><b>${esc(p.symbol)}</b>${S.prefs.targets.includes(p.symbol) ? '' : ' <span class="dim">(paused)</span>'}</td><td>${p.balance > 0 ? amt(p.balance) : '—'}</td><td>${p.balance > 0 ? usd(p.value) : '—'}</td><td class="${p.balance > 0 ? cls(p.pnlPct) : 'dim'}">${p.balance > 0 ? pct(p.pnlPct) : '—'}</td></tr>`,
  );
  rows.push(`<tr><td><b>${esc(S.info.baseSymbol)}</b> <span class="dim">cash</span></td><td>${amt(S.snap.baseBalance)}</td><td>${usd(S.snap.baseBalance)}</td><td class="dim">—</td></tr>`);
  $('positions').innerHTML = rows.join('');
}

function renderChat() {
  if (S.chat.length === lastChatLen) return;
  lastChatLen = S.chat.length;
  const el = $('chatlog');
  el.innerHTML = S.chat
    .map((m, i) => {
      const sign = m.ownerTx ? `<span class="sign"><button class="btn primary" data-sign="${i}">✍ Sign as owner</button></span>` : '';
      return `<div class="msg ${m.role === 'user' ? 'me' : 'bot'}">${esc(m.text)}${sign}</div>`;
    })
    .join('');
  el.scrollTop = el.scrollHeight;
}

// ------------------------------------------------------------------ verify modal
async function verify(id) {
  const box = $('modalBox');
  $('modal').classList.add('open');
  box.innerHTML = '<p class="muted">Fetching the reasoning record…</p>';
  try {
    const d = await API.getDecision(id);
    const recomputed = keccak256Utf8(d.json);
    const ok = recomputed === d.reasoningHash;
    let pretty = d.json;
    try {
      pretty = JSON.stringify(JSON.parse(d.json), null, 2);
    } catch {
      /* keep raw */
    }
    const where = d.explorer
      ? `It is stored on-chain in <a href="${esc(d.explorer)}" target="_blank" rel="noopener">this transaction</a> (event <span class="mono">${d.action === 'BUY' || d.action === 'SELL' ? 'TradeExecuted' : 'DecisionAttested'}</span>).`
      : 'In live mode this hash is emitted by the vault contract in the trade transaction.';
    box.innerHTML = `
      <h3>Proof of reasoning · decision #${d.id}</h3>
      <div class="muted">${esc(d.action)} ${esc(d.symbol)} @ ${price(d.price)} · ${esc(d.summary)}</div>
      <div class="check ${ok ? 'ok' : 'bad'}"><span class="big">${ok ? '✅' : '❌'}</span><div>
        ${ok ? '<b>Hash matches.</b> Your browser re-hashed the transcript below with keccak256 and got the exact hash the agent committed. This is exactly what the council said when it acted. Nothing can be edited after the fact.' : '<b>Hash mismatch.</b> The record was altered.'}
        <br><span class="muted">${where}</span></div></div>
      <div class="hashrow">committed&nbsp; ${esc(d.reasoningHash)}</div>
      <div class="hashrow">recomputed ${esc(recomputed)}</div>
      <pre>${esc(pretty)}</pre>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="tamper">Try tampering</button><button class="btn primary" id="closeModal">Close</button></div>`;
    $('closeModal').onclick = closeModal;
    $('tamper').onclick = () => {
      const forged = d.json.replace(/"votes":(\d)/, (m, v) => `"votes":${(Number(v) % 3) + 1}`);
      const h = keccak256Utf8(forged);
      $('tamper').outerHTML = `<span class="mono down" style="font-size:12px;align-self:center">changed one vote → ${short(h, 10, 6)} ≠ committed ❌</span>`;
    };
  } catch (e) {
    box.innerHTML = `<p class="down">${esc(e.message)}</p><button class="btn" id="closeModal">Close</button>`;
    $('closeModal').onclick = closeModal;
  }
}
function closeModal() {
  $('modal').classList.remove('open');
}

// ------------------------------------------------------------------ owner wallet (live mode)
const CHAINS = {
  177: { chainId: '0xb1', chainName: 'HashKey Chain', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: ['https://mainnet.hsk.xyz'], blockExplorerUrls: ['https://hsk.blockscout.com'] },
  133: { chainId: '0x85', chainName: 'HashKey Chain Testnet', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: ['https://testnet.hsk.xyz'], blockExplorerUrls: ['https://testnet-explorer.hsk.xyz'] },
};
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const POLICY_KEYS = ['maxTradeBps', 'maxPositionBps', 'maxSlippageBps', 'maxDailyLossBps', 'stopLossBps', 'takeProfitBps', 'maxTradesPerDay', 'cooldown', 'quorum'];
function calldata(method, arg) {
  if (method === 'setPolicy') {
    const sel = keccak256Utf8('setPolicy((uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint32,uint8))').slice(0, 10);
    return sel + POLICY_KEYS.map((k) => word(arg[k])).join('');
  }
  if (method === 'setPaused') return keccak256Utf8('setPaused(bool)').slice(0, 10) + word(arg ? 1 : 0);
  if (method === 'resetCircuitBreaker') return keccak256Utf8('resetCircuitBreaker()').slice(0, 10);
  throw new Error('unknown method');
}

function walletError(e) {
  const code = e?.code ?? e?.data?.code;
  if (code === 4001) return new Error('You cancelled the request in MetaMask.');
  if (code === 4100) return new Error('MetaMask has not authorized this site for that account or network. Approve the permission prompt and try again.');
  if (code === -32002) return new Error('MetaMask already has a request open. Click the MetaMask icon and finish it.');
  return e instanceof Error ? e : new Error(e?.message ?? String(e));
}

/** Make sure MetaMask is on the vault's network AND has granted this site that network. */
async function ensureChain(eth) {
  const chain = CHAINS[S.info.chainId];
  if (!chain) return;
  try {
    // always ask: on new MetaMask versions this also grants the site permission for the network
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.chainId }] });
  } catch (e) {
    if (e?.code === 4902 || /unrecognized chain|not been added/i.test(e?.message ?? '')) {
      await eth.request({ method: 'wallet_addEthereumChain', params: [chain] });
    } else throw e;
  }
}

async function connectWallet() {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found. Install MetaMask (or any EIP-1193 wallet).');
  let accounts = await eth.request({ method: 'eth_accounts' });
  if (!accounts?.length) accounts = await eth.request({ method: 'eth_requestAccounts' });
  await ensureChain(eth);
  ownerAccount = accounts[0];
  $('walletBtn').textContent = `Owner ${short(ownerAccount)}`;
  if (S.info.owner && ownerAccount.toLowerCase() !== S.info.owner.toLowerCase()) {
    toast(`Heads up: ${short(ownerAccount)} is not the vault owner (${short(S.info.owner)}). Switch account in MetaMask.`);
  }
  return ownerAccount;
}

async function sendOwnerTx(data) {
  const eth = window.ethereum;
  const send = async () => {
    const from = await connectWallet();
    return eth.request({ method: 'eth_sendTransaction', params: [{ from, to: S.info.vault, data }] });
  };
  try {
    return await send();
  } catch (e) {
    if ((e?.code ?? e?.data?.code) !== 4100) throw walletError(e);
    // not authorized yet: ask MetaMask for account permission, then try once more
    try {
      await eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      return await send();
    } catch (e2) {
      throw walletError(e2);
    }
  }
}

async function ownerTx(method, arg) {
  // simulation (or agent holds the owner key): the server executes it directly
  const r = await API.owner(method, arg);
  if (r.done) return toast(method === 'setPaused' ? (arg ? 'Kill switch engaged' : 'Kill switch released') : 'Done on-chain');
  // live: the owner signs in their wallet
  let hash;
  try {
    hash = await sendOwnerTx(calldata(method, arg));
  } catch (e) {
    API.refresh().catch(() => {}); // release the agent's price-feed hold
    throw e;
  }
  toast(`Owner tx sent ${short(hash)}. Waiting for confirmation…`);
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const rec = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (rec) {
      await API.refresh();
      return toast(rec.status === '0x1' ? 'Owner transaction confirmed ✅' : 'Owner transaction reverted ❌');
    }
  }
  toast('Still waiting for confirmation. The dashboard updates automatically when it lands.');
}

// ------------------------------------------------------------------ misc UI
let toastTimer;
function toast(text, kind = '') {
  const t = $('toast');
  t.className = `toast show ${kind}`;
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 4200);
}
function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.add('show');
}
function hideBanner() {
  $('banner').classList.remove('show');
}

async function sendChat(text) {
  if (!text.trim()) return;
  try {
    S.chat = [...S.chat, { role: 'user', text }];
    renderChat();
    await API.chat(text);
  } catch (e) {
    toast(`Chat failed: ${e.message}`);
  }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, .modal');
  if (!t) return;
  try {
    if (t.id === 'modal' && e.target === t) return closeModal();
    if (t.dataset.sym) {
      symbol = t.dataset.sym;
      render();
    } else if (t.dataset.filter) {
      feedFilter = t.dataset.filter;
      for (const b of document.querySelectorAll('[data-filter]')) b.classList.toggle('active', b === t);
      $('feed').dataset.key = '';
      renderFeed();
    } else if (t.dataset.verify) {
      verify(t.dataset.verify);
    } else if (t.dataset.preset) {
      sendChat(`${t.dataset.preset} preset`);
    } else if (t.dataset.sign !== undefined) {
      const m = S.chat[Number(t.dataset.sign)];
      if (m?.ownerTx) await ownerTx(m.ownerTx.method, m.ownerTx.policy ?? m.ownerTx.arg);
    } else if (t.id === 'killBtn') {
      await ownerTx('setPaused', !S.snap.paused);
    } else if (t.id === 'walletBtn') {
      try {
        await connectWallet();
      } catch (err) {
        throw walletError(err);
      }
    } else if (t.parentElement?.id === 'sugg') {
      sendChat(t.textContent);
    }
  } catch (err) {
    toast(err?.message ?? String(err));
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());
$('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('askInput');
  const v = input.value;
  input.value = '';
  sendChat(v);
});
window.addEventListener('resize', () => S && (drawChart(), drawSpark()));

// ------------------------------------------------------------------ boot
API.connect((type, payload) => {
  if (type === 'state') {
    S = payload;
    render();
  } else if (type === 'trade') {
    const pnl = payload.side === 'SELL' ? ` · PnL ${signed(payload.pnl)}` : '';
    toast(`${payload.side} ${payload.symbol} · ${payload.trigger.replace('_', ' ')}${pnl}`, payload.side);
  } else if (type === 'thinking' && S) {
    S.thinking = payload;
    renderCouncil();
  }
});
