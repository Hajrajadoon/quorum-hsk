// Natural-language control. A deterministic parser handles the common commands instantly;
// anything it does not understand is handed to the LLM (if configured).

const num = (s) => Number(String(s).replace(',', '.'));

/** Resolve a user-typed asset name to a known symbol (HSK -> WHSK, ETH -> WETH, ...). */
export function resolveSymbol(word, symbols) {
  if (!word) return null;
  const w = word.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!w) return null;
  for (const s of symbols) {
    const S = s.toUpperCase();
    if (S === w || S === 'W' + w || 'W' + S === w || S.replace(/^Q/, '') === w || S.replace(/^QW?/, '') === w) return s;
  }
  return null;
}

function findSymbols(text, symbols) {
  const found = [];
  for (const word of text.split(/[^A-Za-z0-9]+/)) {
    const s = resolveSymbol(word, symbols);
    if (s && !found.includes(s)) found.push(s);
  }
  return found;
}

function percent(text, re) {
  const m = text.match(re);
  return m ? num(m[1]) : null;
}

/**
 * @returns {{intent:string, args?:object}}
 */
export function parseIntent(raw, symbols) {
  const text = String(raw || '').trim();
  const t = text.toLowerCase();
  if (!t) return { intent: 'unknown' };

  if (/^(help|\?|commands|what can you do)/.test(t)) return { intent: 'help' };

  // emergency exits first
  if (/(close|sell|exit|liquidate|dump)\s+(all|everything|every position|positions)|panic|flatten/.test(t)) {
    return { intent: 'closeAll' };
  }
  if (/^(close|sell|exit)\b/.test(t)) {
    const syms = findSymbols(text, symbols);
    if (syms.length) return { intent: 'close', args: { symbol: syms[0] } };
  }

  if (/\b(resume|unpause|start trading|continue|go live|turn on)\b/.test(t)) return { intent: 'resume' };
  if (/\b(pause|stop trading|halt|kill switch|freeze|turn off)\b/.test(t) && !/stop[- ]?loss/.test(t)) return { intent: 'pause' };

  if (/\bwhy\b|explain|reason|rationale/.test(t)) return { intent: 'why' };

  if (/\b(analy[sz]e|opinion|think about|view on|outlook)\b/.test(t)) {
    const syms = findSymbols(text, symbols);
    return { intent: 'analyze', args: { symbol: syms[0] ?? null } };
  }

  // presets
  if (/conservative|safer|safe mode|low risk|less risk|careful|cautious|defensive/.test(t)) return { intent: 'preset', args: { name: 'conservative' } };
  if (/aggressive|high risk|more risk|degen|yolo|risk on/.test(t)) return { intent: 'preset', args: { name: 'aggressive' } };
  if (/balanced|medium risk|moderate|normal risk|default/.test(t)) return { intent: 'preset', args: { name: 'balanced' } };

  // individual policy parameters
  const sl = percent(t, /stop[- ]?loss[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*%?/);
  if (sl !== null) return { intent: 'setParam', args: { key: 'stopLossBps', value: Math.round(sl * 100) } };
  const tp = percent(t, /take[- ]?profit[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*%?/);
  if (tp !== null) return { intent: 'setParam', args: { key: 'takeProfitBps', value: Math.round(tp * 100) } };
  const slip = percent(t, /slippage[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*%?/);
  if (slip !== null) return { intent: 'setParam', args: { key: 'maxSlippageBps', value: Math.round(slip * 100) } };
  const dl = percent(t, /(?:daily|day)[- ]?loss[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*%?/);
  if (dl !== null) return { intent: 'setParam', args: { key: 'maxDailyLossBps', value: Math.round(dl * 100) } };
  const pos = percent(t, /(?:max(?:imum)?\s+)?(?:position|exposure)(?:\s+(?:size|cap|limit))?[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*%/);
  if (pos !== null) return { intent: 'setParam', args: { key: 'maxPositionBps', value: Math.round(pos * 100) } };
  const size = percent(t, /(?:trade|order|bet|ticket)\s*(?:size)?[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*%/);
  if (size !== null) return { intent: 'setParam', args: { key: 'maxTradeBps', value: Math.round(size * 100) } };
  const perDay = t.match(/([0-9]+)\s*(?:trades|buys)\s*(?:a|per)\s*day/);
  if (perDay) return { intent: 'setParam', args: { key: 'maxTradesPerDay', value: Number(perDay[1]) } };
  const every = t.match(/(?:every|cooldown(?: of| to)?)\s*([0-9]+(?:[.,][0-9]+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hours)\b/);
  if (every) {
    const unit = every[2][0];
    const mult = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    return { intent: 'setParam', args: { key: 'cooldown', value: Math.round(num(every[1]) * mult) } };
  }
  if (/unanimous/.test(t)) return { intent: 'setParam', args: { key: 'quorum', value: 3 } };
  const q = t.match(/quorum\s*(?:of|to)?\s*([1-3])/);
  if (q) return { intent: 'setParam', args: { key: 'quorum', value: Number(q[1]) } };

  // size multiplier (agent-side)
  if (/smaller|half size|reduce size|less size|trade less/.test(t)) return { intent: 'sizeMult', args: { factor: 0.5 } };
  if (/bigger|larger|full size|increase size|trade more/.test(t)) return { intent: 'sizeMult', args: { factor: 2 } };

  // asset selection
  const syms = findSymbols(text, symbols);
  if (/(trade|use)\s+(all|everything|every asset)/.test(t)) return { intent: 'targets', args: { mode: 'all' } };
  if (syms.length && /\bonly\b/.test(t)) return { intent: 'targets', args: { mode: 'only', symbols: syms } };
  if (syms.length && /\b(add|include|also)\b/.test(t)) return { intent: 'targets', args: { mode: 'add', symbols: syms } };
  if (syms.length && /\b(remove|exclude|drop|avoid|don't trade|dont trade|no more)\b/.test(t)) {
    return { intent: 'targets', args: { mode: 'remove', symbols: syms } };
  }

  if (/faster|speed up/.test(t)) return { intent: 'speed', args: { factor: 0.5 } };
  if (/slower|slow down/.test(t)) return { intent: 'speed', args: { factor: 2 } };

  if (/status|portfolio|pnl|p&l|profit|position|balance|how are we|how're we|how am i|summary|holdings|equity/.test(t)) {
    return { intent: 'status' };
  }
  if (/polic|guardrail|limits|rules|settings|risk/.test(t)) return { intent: 'policy' };

  return { intent: 'unknown' };
}

export const INTENT_SCHEMA_FOR_LLM = `Map the user's message to ONE of these intents and reply with ONLY JSON:
{"intent":"help"} | {"intent":"status"} | {"intent":"policy"} | {"intent":"why"}
{"intent":"pause"} | {"intent":"resume"} | {"intent":"closeAll"} | {"intent":"close","args":{"symbol":"SYM"}}
{"intent":"analyze","args":{"symbol":"SYM"}}
{"intent":"preset","args":{"name":"conservative"|"balanced"|"aggressive"}}
{"intent":"setParam","args":{"key":"maxTradeBps"|"maxPositionBps"|"maxSlippageBps"|"maxDailyLossBps"|"stopLossBps"|"takeProfitBps"|"maxTradesPerDay"|"cooldown"|"quorum","value":INTEGER}}  (bps: 1% = 100; cooldown in seconds)
{"intent":"sizeMult","args":{"factor":NUMBER}} | {"intent":"targets","args":{"mode":"only"|"add"|"remove"|"all","symbols":["SYM"]}}
{"intent":"chat","args":{"answer":"short helpful answer for general questions"}}`;

export const HELP_TEXT = [
  'Try: "status", "why did you buy?", "analyze HSK"',
  'Risk: "be more conservative", "aggressive mode", "stop loss 2%", "take profit 8%", "max trade size 10%", "trade every 5 minutes", "unanimous votes only"',
  'Assets: "only trade HSK", "add WETH", "remove WETH", "trade all"',
  'Size: "trade smaller", "full size"',
  'Control: "pause", "resume", "close all", "sell HSK"',
].join('\n');
