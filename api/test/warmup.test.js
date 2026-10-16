import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-warmup-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'x'.repeat(64));

const cfgStore = await import('../coach/config.js');
const { warmOnce, isLocalEndpoint } = await import('../coach/warmup.js');
const { buildPromptParts } = await import('../coach/core/prompt.js');

test('warmup pings the compatible endpoint once per chat kind, with the real rules prefix', async t => {
  cfgStore.reset();
  cfgStore.save({ enabled: true, provider: 'compatible', models: { compatible: 'm1' }, providerOptions: { compatible: { baseUrl: 'http://ollama:11434' } } });
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"coach_contract":1}' }, finish_reason: 'stop' }] }), { status: 200 });
  };
  const quiet = { log: () => {} };
  t.after(() => cfgStore.reset());

  const r = await warmOnce({ log: quiet, fetch: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2);
  const reviewPrefix = buildPromptParts('review', {}).system;
  assert.ok(seen[1].messages[0].content.endsWith(reviewPrefix), 'review is warmed LAST, so the single live slot ends up holding it');
  assert.ok(seen[0].messages[0].content.endsWith(buildPromptParts('debrief', {}).system));
  assert.equal(seen[0].model, 'm1');

  cfgStore.save({ provider: 'anthropic' });
  assert.equal((await warmOnce({ log: quiet, fetch: fakeFetch })).skipped, true, 'cloud providers are never pinged');
});

test('warmup never pings a metered gateway such as OpenRouter', async t => {
  cfgStore.reset();
  cfgStore.save({ enabled: true, provider: 'compatible', models: { compatible: 'm1' }, providerOptions: { compatible: { baseUrl: 'https://openrouter.ai/api' } } });
  t.after(() => cfgStore.reset());
  let calls = 0;
  const r = await warmOnce({ log: { log() {} }, fetch: async () => { calls++; return new Response('{}'); } });
  assert.equal(r.skipped, true);
  assert.equal(calls, 0);
});

test('isLocalEndpoint', () => {
  for (const u of ['http://localhost:11434', 'http://127.0.0.1:8080', 'http://192.168.1.50:11434', 'http://10.0.0.2', 'http://172.20.0.5', 'http://ollama:11434', 'http://box.lan', 'http://[::1]:11434'])
    assert.equal(isLocalEndpoint(u), true, u);
  for (const u of ['https://openrouter.ai/api', 'https://api.together.xyz', 'http://172.32.0.1', 'http://8.8.8.8', 'not a url'])
    assert.equal(isLocalEndpoint(u), false, u);
});
