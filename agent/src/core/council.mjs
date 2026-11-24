// The Quorum council: three AI agents with different mandates debate every decision.
// A deterministic rule engine always runs (so the system works with no AI key and the risk
// officer's veto can never be talked away). If an LLM is configured, each agent's stance and
// rationale come from the model, grounded in the same features and the rule engine's suggestion.

import { clamp, round } from './indicators.mjs';

export const COUNCIL = [
  {
    id: 'atlas',
    name: 'Atlas',
    role: 'Momentum Quant',
    color: '#5B8CFF',
    persona:
      'You are Atlas, a disciplined momentum trader. You follow trends: you buy confirmed uptrends ' +
      '(fast EMA above slow EMA with positive momentum) and exit downtrends. You never fight the trend.',
  },
  {
    id: 'nyx',
    name: 'Nyx',
    role: 'Contrarian & Arbitrage',
    color: '#C17BFF',
    persona:
      'You are Nyx, a contrarian and arbitrageur. You buy when the DEX (HSKSwap) trades below the ' +
      'reference price (positive spreadBps) or when the asset is oversold, and you sell into premiums ' +
      'and overbought spikes. You love mispricings and distrust crowds.',
  },
  {
    id: 'sentinel',
    name: 'Sentinel',
    role: 'Risk Officer · veto',
    color: '#22D3A0',
    persona:
      'You are Sentinel, the risk officer. Your job is capital preservation. You approve trades (vote ' +
      'BUY) only when volatility is normal, exposure is reasonable and the daily loss budget is healthy. ' +
      'You vote SELL to cut losing positions early. You can veto, and a hard veto cannot be overridden.',
  },
];

const STANCES = ['BUY', 'SELL', 'HOLD'];

function vote(stance, confidence, rationale, extra = {}) {
  return { stance, confidence: round(clamp(confidence, 0, 1), 2), rationale, ...extra };
}

/** @param {CouncilContext} ctx */
function atlasRules(ctx) {
  const { f, holding } = ctx;
  const g = f.emaGapPct;
  const m = f.momentumPct;
  const strength = 0.45 + Math.min(Math.abs(g), 2) * 0.18 + Math.min(Math.abs(m), 3) * 0.05;
  if (g > 0.05 && m > 0) {
    return vote('BUY', strength, `Uptrend: EMA8 is ${g}% above EMA21 and 10-tick momentum is +${m}%. Ride it.`);
  }
  if (g < -0.05 && m < 0) {
    if (holding && g < -0.35 && ctx.pnlPct < 0) {
      return vote('SELL', strength, `Trend broke: EMA8 is ${Math.abs(g)}% below EMA21, momentum ${m}%. Exit.`);
    }
    return vote('HOLD', 0.6, `Downtrend (EMA gap ${g}%, momentum ${m}%). Stay flat, no catching knives.`);
  }
  return vote('HOLD', 0.5, `No clear trend (EMA gap ${g}%, momentum ${m}%). Waiting for confirmation.`);
}

function nyxRules(ctx) {
  const { f, holding } = ctx;
  const s = f.spreadBps;
  if (f.refPrice && s > 60) {
    return vote('BUY', 0.5 + Math.min(s, 250) / 500, `HSKSwap is ${round(s / 100, 2)}% below the reference price. Arbitrage window, buy the discount.`);
  }
  if (f.refPrice && holding && ctx.pnlPct > 0.8 && s <= 0) {
    return vote('SELL', 0.72, `Discount has closed (spread ${s} bps) and the position is +${round(ctx.pnlPct, 2)}%. Bank the arbitrage.`);
  }
  if (f.refPrice && s < -60 && holding) {
    return vote('SELL', 0.5 + Math.min(-s, 250) / 500, `HSKSwap trades ${round(-s / 100, 2)}% above reference. Sell into the premium.`);
  }
  if (f.rsi < 32 || f.zscore < -1.6) {
    return vote('BUY', 0.55 + Math.min(Math.abs(f.zscore), 3) * 0.08, `Oversold: RSI ${f.rsi}, z-score ${f.zscore}. Mean reversion favours a bounce.`);
  }
  if ((f.rsi > 68 || f.zscore > 1.6) && holding) {
    return vote('SELL', 0.55 + Math.min(Math.abs(f.zscore), 3) * 0.08, `Overbought: RSI ${f.rsi}, z-score ${f.zscore}. Take profit into strength.`);
  }
  return vote('HOLD', 0.45, `Fairly priced: spread ${f.spreadBps} bps, RSI ${f.rsi}, z ${f.zscore}. Nothing to exploit.`);
}

function sentinelRules(ctx) {
  const { f, holding, pnlPct, exposurePct, policy, dailyLossUsedPct, halted } = ctx;
  const vetoes = [];
  if (halted) vetoes.push('on-chain circuit breaker is active');
  if (f.volRatio > 1.8) vetoes.push(`volatility spiked to ${f.volRatio}x its baseline`);
  if (exposurePct > (policy.maxPositionBps / 100) * 0.9) vetoes.push(`exposure ${round(exposurePct, 1)}% is near the ${policy.maxPositionBps / 100}% cap`);
  if (dailyLossUsedPct > 70) vetoes.push(`${round(dailyLossUsedPct, 0)}% of today's loss budget is used`);

  const stopPct = policy.stopLossBps / 100;
  if (holding && pnlPct <= -stopPct * 0.8) {
    return vote('SELL', 0.8, `Position is ${round(pnlPct, 2)}% under water, 80% of the way to the ${stopPct}% stop. Cut it early.`, { veto: vetoes.length > 0, vetoReasons: vetoes });
  }
  if (vetoes.length) {
    return vote('HOLD', 0.9, `VETO on new risk: ${vetoes.join('; ')}.`, { veto: true, vetoReasons: vetoes });
  }
  if (holding && pnlPct < -0.5) {
    return vote('HOLD', 0.7, `No averaging down: the open position is ${round(pnlPct, 2)}%. Not approving more size.`, { veto: false, vetoReasons: [] });
  }
  if (f.rsi < 72 && f.momentumPct > -2) {
    return vote('BUY', 0.55 + (1 - Math.min(f.volRatio, 1.8) / 1.8) * 0.3, `Risk budget OK: volatility ${f.volRatio}x baseline, exposure ${round(exposurePct, 1)}%, loss budget used ${round(dailyLossUsedPct, 0)}%. Approved.`, { veto: false, vetoReasons: [] });
  }
  return vote('HOLD', 0.6, `Conditions stretched (RSI ${f.rsi}, momentum ${f.momentumPct}%). Not approving new risk.`, { veto: false, vetoReasons: [] });
}

const RULES = { atlas: atlasRules, nyx: nyxRules, sentinel: sentinelRules };

/**
 * @typedef {object} CouncilContext
 * @property {string} symbol
 * @property {object} f features()
 * @property {boolean} holding
 * @property {number} pnlPct unrealized % of the current position
 * @property {number} exposurePct position cost as % of equity
 * @property {object} policy on-chain policy
 * @property {number} dailyLossUsedPct
 * @property {boolean} halted
 */

/**
 * Ask every council member for a vote.
 * @param {CouncilContext} ctx
 * @param {{llm?: {json: Function}|null}} opts
 */
export async function deliberate(ctx, opts = {}) {
  const ruleVotes = COUNCIL.map((m) => ({ ...RULES[m.id](ctx), source: 'rules' }));
  const { llm } = opts;
  if (!llm) return COUNCIL.map((m, i) => withMeta(m, ruleVotes[i]));

  const results = await Promise.all(
    COUNCIL.map(async (m, i) => {
      const rule = ruleVotes[i];
      try {
        const out = await llm.json(
          [
            {
              role: 'system',
              content:
                `${m.persona}\nYou sit on a 3-member AI trading council for a vault on HSK Chain. ` +
                'Reply with ONLY a JSON object: {"stance":"BUY"|"SELL"|"HOLD","confidence":0..1,"rationale":"one or two sentences citing the numbers"}. ' +
                'SELL is only valid when the vault holds the asset.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                asset: ctx.symbol,
                market: ctx.f,
                position: { holding: ctx.holding, unrealizedPct: round(ctx.pnlPct, 2), exposurePct: round(ctx.exposurePct, 2) },
                policy: ctx.policy,
                dailyLossBudgetUsedPct: round(ctx.dailyLossUsedPct, 1),
                quantModelSuggestion: { stance: rule.stance, confidence: rule.confidence, rationale: rule.rationale },
              }),
            },
          ],
          { maxTokens: 220 },
        );
        let stance = String(out?.stance ?? '').toUpperCase();
        if (!STANCES.includes(stance)) throw new Error('bad stance');
        if (stance === 'SELL' && !ctx.holding) stance = 'HOLD';
        const confidence = clamp(Number(out.confidence), 0, 1);
        if (!Number.isFinite(confidence)) throw new Error('bad confidence');
        const rationale = String(out.rationale ?? '').slice(0, 400) || rule.rationale;
        const merged = { ...rule, stance, confidence: round(confidence, 2), rationale, source: 'llm' };
        if (m.id === 'sentinel' && rule.veto) {
          // hard veto: the LLM can explain it, but cannot lift it
          merged.veto = true;
          if (merged.stance === 'BUY') merged.stance = 'HOLD';
        }
        return withMeta(m, merged);
      } catch {
        return withMeta(m, rule);
      }
    }),
  );
  return results;
}

function withMeta(m, v) {
  return { id: m.id, name: m.name, role: m.role, color: m.color, ...v };
}

/**
 * Turn three votes into one decision.
 * @returns {{action:'BUY'|'SELL'|'HOLD'|'VETO', votes:number, confidence:number, summary:string}}
 */
export function tally(votes, quorum, holding) {
  const by = { BUY: [], SELL: [], HOLD: [] };
  for (const v of votes) by[v.stance].push(v);
  const veto = votes.some((v) => v.veto);
  const avg = (arr) => (arr.length ? round(arr.reduce((a, v) => a + v.confidence, 0) / arr.length, 2) : 0);
  const names = (arr) => arr.map((v) => v.name).join(' + ');

  if (by.BUY.length >= quorum) {
    if (veto) {
      return { action: 'VETO', votes: by.BUY.length, confidence: avg(by.BUY), summary: `${names(by.BUY)} wanted to buy, Sentinel vetoed.` };
    }
    return { action: 'BUY', votes: by.BUY.length, confidence: avg(by.BUY), summary: `${names(by.BUY)} reached quorum to BUY.` };
  }
  if (holding && by.SELL.length >= quorum) {
    return { action: 'SELL', votes: by.SELL.length, confidence: avg(by.SELL), summary: `${names(by.SELL)} reached quorum to SELL.` };
  }
  const top = Math.max(by.BUY.length, by.SELL.length);
  return {
    action: 'HOLD',
    votes: Math.max(by.HOLD.length, 3 - top),
    confidence: avg(by.HOLD),
    summary: top > 0 ? `No quorum (${by.BUY.length} buy / ${by.SELL.length} sell / ${by.HOLD.length} hold). Holding.` : 'Unanimous HOLD.',
  };
}
