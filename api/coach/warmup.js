/* Keeps a local model's prefix cache warm, so nobody pays the cold start.
 *
 * The rules ride as a byte-identical system message precisely so a llama.cpp/Ollama endpoint
 * can reuse its KV prefix across jobs — but the cache only exists after something has sent
 * that prefix once, and it dies with the ollama process. Without this, the first review after
 * a reboot quietly costs ~8 minutes instead of ~1, and whoever asks it looks unlucky.
 *
 * So: when the configured provider is a compatible endpoint, send each chat prefix once at
 * boot and then again every half hour. A warm ping is nearly free (the prefix is cached, one
 * token comes back); a cold one does the expensive read exactly once, off anyone's clock.
 * Cloud providers are never pinged — their caches are their problem, and requests cost money.
 * That includes "compatible" endpoints that are really a metered cloud gateway (OpenRouter and
 * the like): only an endpoint that looks self-hosted is warmed. COACH_WARMUP=on/off overrides.
 */
import * as cfgStore from './config.js';
import { baseUrlFor } from './core/providers.js';
import { adapterFor } from './adapters/index.js';
import { buildPromptParts } from './core/prompt.js';
import os from 'node:os';
import { fetchFor } from './node-fetch.js';

const INTERVAL_MS = 30 * 60000;
const TIMEOUT_MS = 10 * 60000;
// The two kinds a chat runs day to day; `create` happens once per user and may pay cold.
// Review is deliberately LAST: with OLLAMA_NUM_PARALLEL=1 there is one live slot, it belongs
// to whatever ran most recently, and the fallback restore from the prompt cache is not
// reliable for large prompts — so the slot must end up holding the kind people actually use.
// (Measured: a review right after a debrief ping took 402 s; right after a review ping, 26 s.)
const KINDS = ['debrief', 'review'];

let running = false;

/** A self-hosted server is on this machine or this network: loopback, a private address, a bare
 *  service name (`ollama`), or a conventional local suffix. A public FQDN is assumed metered. */
export function isLocalEndpoint(baseUrl) {
  let host;
  try { host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (!host.includes('.')) return true;
  return /\.(local|lan|internal|home\.arpa)$/.test(host);
}

function warmupAllowed(cfg) {
  const flag = String(process.env.COACH_WARMUP || '').toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return isLocalEndpoint(baseUrlFor(cfg.provider, cfg));
}

export async function warmOnce({ log = console, fetch: fetchImpl } = {}) {
  const cfg = cfgStore.load();
  if (!cfgStore.isEnabled() || cfg.provider !== 'compatible') return { skipped: true };
  if (!warmupAllowed(cfg)) return { skipped: true };
  const adapter = adapterFor(cfg.provider);
  if (!adapter || adapter.spawns !== false) return { skipped: true };
  if (running) return { skipped: true };
  // Same credential testRun uses: the bound profile's in instance mode. In per-profile mode
  // there is no account to spend on a background ping, so there is nothing to warm.
  const resolved = cfgStore.credentialFor(cfgStore.boundUidFor(cfg));
  if (!resolved.ok) return { skipped: true };
  const env = cfgStore.jobEnv(os.tmpdir(), resolved);
  running = true;
  try {
    for (const kind of KINDS) {
      const parts = buildPromptParts(kind, {});
      const t0 = Date.now();
      const r = await adapter.invoke({
        cfg,
        env,
        system: parts.system,
        prompt: 'Reply with exactly {"coach_contract":1} and nothing else.',
        model: cfgStore.modelFor(cfg),
        timeoutMs: TIMEOUT_MS,
        fetch: fetchImpl || fetchFor(TIMEOUT_MS)
      });
      const ms = Date.now() - t0;
      if (r.code !== 0) {
        const why = String(r.stderr || '').trim().slice(0, 200);
        log.log(`coach warmup (${kind}): endpoint not reachable${why ? ` (${why})` : ''}, will retry later`);
        return { ok: false };
      }
      // >5s means the prefix was actually (re)read — worth a line; a warm ping is noise.
      if (ms > 5000) log.log(`coach warmup (${kind}): prefix cached in ${Math.round(ms / 1000)}s`);
    }
    return { ok: true };
  } finally {
    running = false;
  }
}

/** Boot + every half hour. Never throws; a failed warmup is only a missed optimisation. */
export function startWarmup(log = console) {
  const tick = () => warmOnce({ log }).catch(() => {});
  setTimeout(tick, 5000);                                 // let the container settle first
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  return timer;
}
