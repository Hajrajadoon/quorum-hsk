// Zero-dependency HTTP + Server-Sent-Events server for the dashboard.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTxPage, renderVaultPage } from './pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CORE = path.join(ROOT, 'src', 'core');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep) && file !== base) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, TYPES[path.extname(file)] ?? 'application/octet-stream');
  });
}

function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {import('./core/engine.mjs').QuorumEngine} engine
 * @param {{port:number, host:string, controlToken?:string, log?:Function}} opts
 */
export function startServer(engine, { port, host, controlToken, log = console.log }) {
  const clients = new Set();

  engine.subscribe((type, payload) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
  });

  const authorized = (req) => !controlToken || req.headers['x-quorum-token'] === controlToken;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET') {
        if (p === '/' || p === '/index.html') return serveFile(res, PUBLIC, 'index.html');
        if (p === '/api/health') return send(res, 200, { ok: true, mode: engine.mode, ticks: engine.stats.ticks });
        if (p === '/api/state') return send(res, 200, engine.publicState());
        if (p.startsWith('/api/decision/')) {
          const d = engine.getDecision(p.split('/').pop());
          return d ? send(res, 200, d) : send(res, 404, { error: 'decision not found (too old?)' });
        }
        if (p === '/api/events') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write(`event: state\ndata: ${JSON.stringify(engine.publicState())}\n\n`);
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
          req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return undefined;
        }
        if (p.startsWith('/tx/')) {
          const hash = p.slice(4);
          if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return send(res, 400, 'bad transaction hash', 'text/plain');
          const tx = engine.vault.txDetails ? await engine.vault.txDetails(hash) : { simulated: true };
          let decision = null;
          for (const d of engine.archive.values()) {
            if (d.txHash && d.txHash.toLowerCase() === hash.toLowerCase()) decision = d;
          }
          return send(res, 200, renderTxPage(hash, tx, decision), 'text/html; charset=utf-8');
        }
        if (p === '/vault') {
          const v = engine.vault.vaultDetails ? await engine.vault.vaultDetails() : null;
          if (v && !v.trades.length && engine.trades.length) {
            // event query unavailable (RPC range limits): fall back to the agent's own record of tx hashes
            v.trades = engine.trades.slice(0, 25).map((t) => ({ id: t.id, side: t.side, token: t.symbol, pnl: t.pnl, votes: null, txHash: t.txHash }));
            v.tradesSource = 'agent';
          }
          return send(res, 200, renderVaultPage(v), 'text/html; charset=utf-8');
        }
        if (p.startsWith('/src/core/')) return serveFile(res, CORE, p.slice('/src/core/'.length));
        return serveFile(res, PUBLIC, p.slice(1));
      }

      if (req.method === 'POST') {
        if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-quorum-token' });
        const body = await readBody(req);
        if (p === '/api/chat') {
          const r = await engine.handleChat(String(body.text ?? ''));
          return send(res, 200, r);
        }
        if (p === '/api/control') {
          const map = { pause: 'pause', resume: 'resume', closeAll: 'closeAll' };
          if (!map[body.action]) return send(res, 400, { error: 'unknown action' });
          const r = await engine.handleChat(body.action === 'closeAll' ? 'close all' : body.action);
          return send(res, 200, r);
        }
        if (p === '/api/owner') {
          const r = await engine.ownerCall(String(body.method), body.arg);
          return send(res, 200, r);
        }
        if (p === '/api/refresh') {
          engine.releaseFeedHold?.();
          await engine._refresh();
          engine._emitState();
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log('http error', e);
      return send(res, 500, { error: e?.message ?? 'internal error' });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
