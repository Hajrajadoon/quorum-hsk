// Entry for the standalone demo: runs the whole Quorum engine (simulated market + vault) in the
// browser and exposes it to the dashboard through the same API the HTTP server provides.
import { createSimEngine } from '../src/core/sim.mjs';

async function boot() {
  const { engine } = await createSimEngine({ seed: 1, intervalMs: 2200 });
  window.QUORUM_API = {
    connect(onEvent) {
      engine.subscribe(onEvent);
      onEvent('state', engine.publicState());
      engine.start();
    },
    getDecision: async (id) => {
      const d = engine.getDecision(id);
      if (!d) throw new Error('decision not found');
      return d;
    },
    chat: (text) => engine.handleChat(text),
    owner: (method, arg) => engine.ownerCall(method, arg),
    refresh: async () => {
      await engine._refresh();
      engine._emitState();
      return { ok: true };
    },
  };
  await import('./app.mjs');
}

boot();
