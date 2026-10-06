// test/proxy.test.js — Runs the real server.js against the mock NIM upstream.
// Run with: npm test

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { startMockNim, answerFor, reasoningFor, NIM_KEY } = require('./mock-nim');

const CLIENT_KEY = 'test-client-key-0123456789abcdef';
const SERVER = path.join(__dirname, '..', 'server.js');

// ─── Helpers ───────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startProxy(nimUrl, extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env };
  // Talk to the mock directly, never through an outbound HTTP proxy
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[k];
  }
  for (const k of ['SHOW_REASONING', 'ENABLE_THINKING_MODE', 'SKIP_VALIDATION', 'DISCORD_WEBHOOK_URL',
    'GLM_REASONING_EFFORT', 'DEEPSEEK_REASONING_EFFORT', 'REQUEST_TIMEOUT_MS', 'STREAM_KEEPALIVE_MS',
    'INSTRUCTIONS_PATH', 'INSTRUCTIONS_POSITION', 'LOREBOOK_PATH', 'LOREBOOK_SCAN_DEPTH', 'LOREBOOK_TOKEN_BUDGET']) {
    delete env[k];
  }
  Object.assign(env, {
    PORT: String(port),
    NIM_API_BASE: nimUrl,
    NIM_API_KEY: NIM_KEY,
    CLIENT_AUTH_KEY: CLIENT_KEY,
    // Ignore instructions/lorebooks lying around on this machine
    PROMPT_FILES_DEFAULT_LOCATIONS: 'off'
  }, extraEnv);

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });

  const proxy = {
    url: `http://127.0.0.1:${port}`,
    logs: () => logs,
    waitForLog: (text, timeoutMs = 5000) => new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (logs.includes(text)) return resolve();
        if (child.exitCode !== null) return reject(new Error(`Proxy exited early:\n${logs}`));
        if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for "${text}" in:\n${logs}`));
        setTimeout(check, 20);
      };
      check();
    }),
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    })
  };

  await proxy.waitForLog('[PROXY] Hybrid proxy running');
  return proxy;
}

function chat(proxy, body, { auth = CLIENT_KEY, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  return fetch(`${proxy.url}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });
}

// Parses an SSE body into its JSON chunks, checking framing as it goes.
// Comment frames (keep-alive pings) are skipped.
function parseSse(text) {
  const frames = text.split('\n\n').filter(f => f.length > 0 && !f.startsWith(':'));
  const chunks = [];
  let doneCount = 0;
  for (const frame of frames) {
    assert.ok(frame.startsWith('data: '), `bad SSE frame: ${JSON.stringify(frame)}`);
    const payload = frame.slice(6);
    if (payload === '[DONE]') {
      doneCount++;
      continue;
    }
    assert.equal(doneCount, 0, 'chunk arrived after [DONE]');
    chunks.push(JSON.parse(payload));
  }
  assert.equal(doneCount, 1, 'stream must end with exactly one [DONE]');
  return chunks;
}

function streamedContent(chunks) {
  return chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join('');
}

// What SHOW_REASONING renders: thinking on one line, then the reply
function shownReasoning(model, effort) {
  return `<thinking>\n${reasoningFor(model, effort).replace(/\n/g, '\\n')}\n</thinking>\n\n${answerFor(model)}`;
}

const MESSAGES = [
  { role: 'system', content: 'You are a narrator.' },
  { role: 'user', content: 'Say hi.' }
];

// ─── Default configuration ─────────────────────────────────────────────────

describe('default config (thinking hidden, DeepSeek thinking off)', () => {
  let nim;
  let proxy;

  before(async () => {
    nim = await startMockNim();
    proxy = await startProxy(nim.url);
  });

  after(async () => {
    await proxy?.stop();
    await nim?.close();
  });

  const CASES = [
    {
      alias: 'deepseek-v4.1-flash',
      nimId: 'deepseek-ai/deepseek-v4.1-flash',
      kwargs: { thinking: false, enable_thinking: false },
      maxTokens: 2048
    },
    {
      alias: 'glm-5.3',
      nimId: 'z-ai/glm-5.3',
      kwargs: { reasoning_effort: 'low', clear_thinking: true },
      maxTokens: 2048 + 4096
    },
    {
      alias: 'glm-5.3-flash',
      nimId: 'z-ai/glm-5.3-flash',
      kwargs: { reasoning_effort: 'low', clear_thinking: true },
      maxTokens: 2048 + 4096
    }
  ];

  it('lists the aliases on /v1/models without auth', async () => {
    const res = await fetch(`${proxy.url}/v1/models`);
    assert.equal(res.status, 200);
    const ids = (await res.json()).data.map(m => m.id);
    for (const { alias } of CASES) assert.ok(ids.includes(alias), `${alias} missing from ${ids}`);
  });

  it('waits up to 480 s on NIM by default', () => {
    assert.ok(proxy.logs().includes('[CONFIG] Upstream timeout: 480s'), proxy.logs());
  });

  it('finds every mapped model in the NIM catalog at startup', async () => {
    await proxy.waitForLog('[VALIDATION] All models valid.');
    for (const { alias, nimId } of CASES) {
      assert.ok(proxy.logs().includes(`✓ ${alias} → ${nimId}`), `no ✓ line for ${alias}`);
    }
  });

  for (const { alias, nimId, kwargs, maxTokens } of CASES) {
    it(`${alias}: non-streaming reply is clean and the upstream request is right`, async () => {
      const res = await chat(proxy, { model: alias, messages: MESSAGES });
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(body.model, alias);
      assert.equal(body.choices[0].message.content, answerFor(nimId));
      assert.equal(body.choices[0].message.role, 'assistant');
      assert.equal(body.choices[0].finish_reason, 'stop');
      assert.equal(body.choices[0].message.reasoning_content, undefined);
      assert.equal(body.choices[0].message.reasoning, undefined);
      assert.deepEqual(body.usage, { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 });

      const sent = nim.lastRequest();
      assert.equal(sent.model, nimId);
      assert.deepEqual(sent.chat_template_kwargs, kwargs);
      assert.equal(sent.max_tokens, maxTokens);
      assert.equal(sent.stream, false);
      assert.equal(sent.temperature, 0.7);
      assert.deepEqual(sent.messages, MESSAGES);
      assert.ok(!('extra_body' in sent), 'extra_body must not be sent');
    });

    it(`${alias}: streaming reply reassembles exactly, with no thinking leaked`, async () => {
      const res = await chat(proxy, { model: alias, messages: MESSAGES, stream: true, temperature: 1 });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/event-stream/);

      const chunks = parseSse(await res.text());
      assert.equal(streamedContent(chunks), answerFor(nimId));
      for (const c of chunks) {
        const delta = c.choices?.[0]?.delta || {};
        assert.ok(!('reasoning_content' in delta) && !('reasoning' in delta), 'reasoning field leaked');
        assert.equal(c.error, undefined, `stream error chunk: ${JSON.stringify(c)}`);
      }
      assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');

      const sent = nim.lastRequest();
      assert.equal(sent.model, nimId);
      assert.equal(sent.stream, true);
      assert.equal(sent.temperature, 1);
      assert.deepEqual(sent.chat_template_kwargs, kwargs);
    });
  }

  it('adds thinking headroom on top of the client max_tokens, capped at 65536', async () => {
    let res = await chat(proxy, { model: 'glm-5.3-flash', messages: MESSAGES, max_tokens: 1000 });
    assert.equal(res.status, 200);
    assert.equal(nim.lastRequest().max_tokens, 1000 + 4096);

    res = await chat(proxy, { model: 'glm-5.3-flash', messages: MESSAGES, max_tokens: 100000 });
    assert.equal(res.status, 200);
    assert.equal(nim.lastRequest().max_tokens, 65536);

    res = await chat(proxy, { model: 'deepseek-v4.1-flash', messages: MESSAGES, max_tokens: 777 });
    assert.equal(res.status, 200);
    assert.equal(nim.lastRequest().max_tokens, 777);
  });

  it('forwards image content untouched to the multimodal flash models', async () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
      ]
    }];
    for (const model of ['deepseek-v4.1-flash', 'glm-5.3-flash']) {
      const res = await chat(proxy, { model, messages });
      assert.equal(res.status, 200);
      assert.deepEqual(nim.lastRequest().messages, messages);
    }
  });

  it('rejects an unknown alias and names the new ones', async () => {
    const before = nim.requests.length;
    const res = await chat(proxy, { model: 'glm-9000', messages: MESSAGES });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'model_not_found');
    for (const alias of ['deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash']) {
      assert.ok(body.error.message.includes(alias), `${alias} not listed`);
    }
    assert.equal(nim.requests.length, before, 'unknown alias must not reach NIM');
  });

  it('serves the Nemotron models under their own names', async () => {
    for (const [alias, nimId] of [
      ['nemotron-3-ultra', 'nvidia/nemotron-3-ultra-550b-a55b'],
      ['nemotron-3-super', 'nvidia/nemotron-3-super-120b-a12b'],
      ['nemotron-3.5-lightning', 'nvidia/nemotron-3.5-lightning-30b-a3b']
    ]) {
      const res = await chat(proxy, { model: alias, messages: MESSAGES });
      assert.equal(res.status, 200);
      assert.equal(nim.lastRequest().model, nimId);
      assert.equal(nim.lastRequest().chat_template_kwargs, undefined);
    }
  });

  it('tells clients using an old name what to switch to, without calling NIM', async () => {
    const before = nim.requests.length;
    for (const [oldName, now] of [['gpt-4', 'nemotron-3-ultra'], ['glm-5.2', 'glm-5.3'], ['gpt-3.5-turbo', 'nemotron-3-super']]) {
      const res = await chat(proxy, { model: oldName, messages: MESSAGES });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, new RegExp(`renamed to "${now.replace('.', '\\.')}"`));
    }
    for (const [oldName, suggestion] of [['gpt-4o', 'deepseek-v4.1-flash'], ['gpt-4-flash', 'deepseek-v4.1-flash'],
      ['gemini-pro', 'nemotron-3.5-lightning'], ['gpt-3.5o', 'nemotron-3.5-lightning']]) {
      const res = await chat(proxy, { model: oldName, messages: MESSAGES });
      assert.equal(res.status, 400);
      const message = (await res.json()).error.message;
      assert.ok(message.includes('NVIDIA retired') && message.includes(`Try "${suggestion}"`), message);
    }
    assert.equal(nim.requests.length, before);
  });

  it('answers a body that is not JSON with a JSON error, not an HTML page', async () => {
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CLIENT_KEY}` },
      body: '{"model": "glm-5.3", oops'
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal((await res.json()).error.message, 'Request body is not valid JSON');
  });

  it('rejects requests without the client key', async () => {
    const before = nim.requests.length;
    const res = await chat(proxy, { model: 'glm-5.3-flash', messages: MESSAGES }, { auth: null });
    assert.equal(res.status, 403);
    const wrong = await chat(proxy, { model: 'glm-5.3-flash', messages: MESSAGES }, { auth: 'nope' });
    assert.equal(wrong.status, 403);
    assert.equal(nim.requests.length, before);
  });
});

// ─── Thinking enabled and shown ────────────────────────────────────────────

describe('thinking on (ENABLE_THINKING_MODE, SHOW_REASONING, custom efforts)', () => {
  let nim;
  let proxy;

  before(async () => {
    nim = await startMockNim();
    proxy = await startProxy(nim.url, {
      ENABLE_THINKING_MODE: 'true',
      SHOW_REASONING: 'true',
      DEEPSEEK_REASONING_EFFORT: 'max',
      GLM_REASONING_EFFORT: 'high',
      SKIP_VALIDATION: 'true'
    });
  });

  after(async () => {
    await proxy?.stop();
    await nim?.close();
  });

  it('logs the effective thinking settings', () => {
    assert.ok(proxy.logs().includes('DeepSeek-V4.1-Flash thinking: ON (effort max)'));
    assert.ok(proxy.logs().includes('GLM-5.3 / GLM-5.3-Flash reasoning effort: high'));
  });

  it('deepseek-v4.1-flash: turns thinking on with both switches and shows it', async () => {
    const res = await chat(proxy, { model: 'deepseek-v4.1-flash', messages: MESSAGES });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, shownReasoning('deepseek-ai/deepseek-v4.1-flash', 'max'));

    const sent = nim.lastRequest();
    assert.deepEqual(sent.chat_template_kwargs, { thinking: true, enable_thinking: true, reasoning_effort: 'max' });
    assert.equal(sent.max_tokens, 2048 + 16384);
    assert.ok(!('extra_body' in sent), 'extra_body must not be sent');
  });

  it('deepseek-v4.1-flash: streams thinking then reply', async () => {
    const res = await chat(proxy, { model: 'deepseek-v4.1-flash', messages: MESSAGES, stream: true });
    assert.equal(res.status, 200);
    const chunks = parseSse(await res.text());
    assert.equal(streamedContent(chunks), shownReasoning('deepseek-ai/deepseek-v4.1-flash', 'max'));
  });

  for (const [alias, nimId] of [['glm-5.3', 'z-ai/glm-5.3'], ['glm-5.3-flash', 'z-ai/glm-5.3-flash']]) {
    it(`${alias}: uses GLM_REASONING_EFFORT and never gets a thinking switch`, async () => {
      const res = await chat(proxy, { model: alias, messages: MESSAGES });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.choices[0].message.content, shownReasoning(nimId, 'high'));

      const sent = nim.lastRequest();
      assert.deepEqual(sent.chat_template_kwargs, { reasoning_effort: 'high', clear_thinking: true });
      assert.equal(sent.max_tokens, 2048 + 8192);
      assert.ok(!('extra_body' in sent), 'extra_body must not be sent');
    });

    it(`${alias}: streams thinking then reply`, async () => {
      const res = await chat(proxy, { model: alias, messages: MESSAGES, stream: true });
      assert.equal(res.status, 200);
      const chunks = parseSse(await res.text());
      assert.equal(streamedContent(chunks), shownReasoning(nimId, 'high'));
    });
  }
});

// ─── Bad effort values ─────────────────────────────────────────────────────

describe('unsupported effort values fall back to safe defaults', () => {
  let nim;
  let proxy;

  before(async () => {
    nim = await startMockNim();
    proxy = await startProxy(nim.url, {
      ENABLE_THINKING_MODE: 'true',
      // Valid on some serving stacks but not all — the proxy must not pass them on
      DEEPSEEK_REASONING_EFFORT: 'xhigh',
      GLM_REASONING_EFFORT: 'medium',
      SKIP_VALIDATION: 'true'
    });
  });

  after(async () => {
    await proxy?.stop();
    await nim?.close();
  });

  it('deepseek-v4.1-flash falls back to high', async () => {
    const res = await chat(proxy, { model: 'deepseek-v4.1-flash', messages: MESSAGES });
    assert.equal(res.status, 200);
    assert.equal(nim.lastRequest().chat_template_kwargs.reasoning_effort, 'high');
    // Thinking stays hidden without SHOW_REASONING
    assert.equal((await res.json()).choices[0].message.content, answerFor('deepseek-ai/deepseek-v4.1-flash'));
  });

  it('glm-5.3-flash falls back to low', async () => {
    const res = await chat(proxy, { model: 'glm-5.3-flash', messages: MESSAGES });
    assert.equal(res.status, 200);
    assert.equal(nim.lastRequest().chat_template_kwargs.reasoning_effort, 'low');
  });
});

// ─── Upstream timeout ──────────────────────────────────────────────────────

// Same rules as the 480 s default, scaled down to 1 s via REQUEST_TIMEOUT_MS
describe('upstream timeout', () => {
  let slowNim;
  let quietNim;
  let slowProxy;
  let quietProxy;

  before(async () => {
    slowNim = await startMockNim({ headerDelayMs: 3000 });
    quietNim = await startMockNim({ midStreamSilenceMs: 3000 });
    slowProxy = await startProxy(slowNim.url, { REQUEST_TIMEOUT_MS: '1000', SKIP_VALIDATION: 'true' });
    quietProxy = await startProxy(quietNim.url, { REQUEST_TIMEOUT_MS: '1000', SKIP_VALIDATION: 'true' });
  });

  after(async () => {
    await slowProxy?.stop();
    await quietProxy?.stop();
    await slowNim?.close();
    await quietNim?.close();
  });

  it('logs the configured timeout', () => {
    assert.ok(slowProxy.logs().includes('[CONFIG] Upstream timeout: 1s'), slowProxy.logs());
  });

  for (const stream of [false, true]) {
    it(`gives up when NIM does not start answering in time (${stream ? 'streaming' : 'plain'})`, async () => {
      const requestsBefore = slowNim.requests.length;
      const started = Date.now();
      const res = await chat(slowProxy, { model: 'glm-5.3-flash', messages: MESSAGES, stream });
      const elapsed = Date.now() - started;

      assert.equal(res.status, 504);
      assert.match((await res.json()).error.message, /did not start answering within 1s/);
      assert.ok(elapsed >= 900 && elapsed < 2500, `took ${elapsed} ms`);
      // A slow failure is not retried: one request only
      assert.equal(slowNim.requests.length, requestsBefore + 1);
    });
  }

  it('ends a stream that goes silent mid-reply with an error chunk and [DONE]', async () => {
    const started = Date.now();
    const res = await chat(quietProxy, { model: 'deepseek-v4.1-flash', messages: MESSAGES, stream: true });
    assert.equal(res.status, 200);
    const chunks = parseSse(await res.text());
    const elapsed = Date.now() - started;

    assert.equal(chunks.at(-1).error?.type, 'stream_error');
    assert.ok(elapsed >= 900 && elapsed < 2500, `took ${elapsed} ms`);
  });

  it('falls back to 480 s when REQUEST_TIMEOUT_MS is not a positive number', async () => {
    for (const bad of ['abc', '0', '-5']) {
      const proxy = await startProxy(slowNim.url, { REQUEST_TIMEOUT_MS: bad, SKIP_VALIDATION: 'true' });
      try {
        assert.ok(proxy.logs().includes('[CONFIG] Upstream timeout: 480s'), `${bad}: ${proxy.logs()}`);
      } finally {
        await proxy.stop();
      }
    }
  });
});

// ─── NVIDIA errors and retries ─────────────────────────────────────────────

// NVCF's problem+json shape, as NIM sends for retired models
const GONE = {
  status: 410,
  body: { status: 410, title: 'Gone', detail: "The model 'z-ai/glm-5.3' has reached its end of life on 2026-12-01T09:00:00Z" }
};

describe('NVIDIA errors and retries', () => {
  const started = [];
  after(async () => {
    for (const { proxy, nim } of started) {
      await proxy.stop();
      await nim.close();
    }
  });
  const setup = async (mockOptions, env = {}) => {
    const nim = await startMockNim(mockOptions);
    const proxy = await startProxy(nim.url, { SKIP_VALIDATION: 'true', ...env });
    started.push({ proxy, nim });
    return { proxy, nim };
  };

  for (const stream of [false, true]) {
    it(`passes NVIDIA's own error message through (${stream ? 'streaming' : 'plain'})`, async () => {
      const { proxy, nim } = await setup({ failures: [GONE] });
      const res = await chat(proxy, { model: 'glm-5.3', messages: MESSAGES, stream });
      assert.equal(res.status, 410);
      const { error } = await res.json();
      assert.equal(error.message, `NVIDIA NIM error 410: ${GONE.body.detail}`);
      assert.equal(nim.requests.length, 1, '410 must not be retried');
      assert.ok(proxy.logs().includes(GONE.body.detail), 'NVIDIA message missing from the log');
    });
  }

  it('retries once after a quick 503 and then succeeds', async () => {
    const { proxy, nim } = await setup({ failures: [{ status: 503 }] });
    const res = await chat(proxy, { model: 'glm-5.3-flash', messages: MESSAGES });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, answerFor('z-ai/glm-5.3-flash'));
    assert.equal(nim.requests.length, 2);
  });

  it('gives up after the one retry when NVIDIA keeps failing', async () => {
    const { proxy, nim } = await setup({ failures: [{ status: 502 }, { status: 503 }, { status: 504 }] });
    const res = await chat(proxy, { model: 'deepseek-v4.1-flash', messages: MESSAGES, stream: true });
    assert.equal(res.status, 503);
    assert.equal(nim.requests.length, 2);
  });
});

// ─── Keep-alive and client hang-ups ────────────────────────────────────────

describe('stream keep-alive and client hang-ups', () => {
  const started = [];
  after(async () => {
    for (const { proxy, nim } of started) {
      await proxy.stop();
      await nim.close();
    }
  });
  const setup = async (mockOptions, env = {}) => {
    const nim = await startMockNim(mockOptions);
    const proxy = await startProxy(nim.url, { SKIP_VALIDATION: 'true', STREAM_KEEPALIVE_MS: '200', ...env });
    started.push({ proxy, nim });
    return { proxy, nim };
  };

  it('pings a streaming client while NVIDIA is still queueing, then streams the reply', async () => {
    const { proxy } = await setup({ headerDelayMs: 1200 });
    const res = await chat(proxy, { model: 'glm-5.3', messages: MESSAGES, stream: true });
    assert.equal(res.status, 200);
    const text = await res.text();

    const pings = text.split('\n\n').filter(f => f === ': keep-alive').length;
    assert.ok(pings >= 3, `expected several pings, got ${pings}`);
    assert.ok(text.startsWith(': keep-alive'), 'the first thing sent should be a ping');
    assert.equal(streamedContent(parseSse(text)), answerFor('z-ai/glm-5.3'));
  });

  it('does not ping a plain (non-streaming) request', async () => {
    const { proxy } = await setup({ headerDelayMs: 800 });
    const res = await chat(proxy, { model: 'glm-5.3', messages: MESSAGES });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, answerFor('z-ai/glm-5.3'));
  });

  it('reports an NVIDIA error inside the stream once pings have started', async () => {
    const { proxy } = await setup({ headerDelayMs: 700, failures: [GONE] });
    const res = await chat(proxy, { model: 'glm-5.3', messages: MESSAGES, stream: true });
    assert.equal(res.status, 200);
    const chunks = parseSse(await res.text());
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].error.code, 410);
    assert.equal(chunks[0].error.message, `NVIDIA NIM error 410: ${GONE.body.detail}`);
  });

  it('cancels the NVIDIA request when the client hangs up while waiting', async () => {
    const { proxy, nim } = await setup({ headerDelayMs: 3000 });
    const controller = new AbortController();
    const pending = chat(proxy, { model: 'glm-5.3', messages: MESSAGES, stream: true }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 400);
    await assert.rejects(pending.then(r => r.text()));

    await proxy.waitForLog('Client disconnected before NVIDIA answered; request cancelled', 2000);
    await waitFor(() => nim.disconnects() === 1, 'NVIDIA connection was not closed');
  });

  it('stops reading from NVIDIA when the client hangs up mid-reply', async () => {
    const { proxy, nim } = await setup({ midStreamSilenceMs: 3000 });
    const controller = new AbortController();
    const res = await chat(proxy, { model: 'glm-5.3', messages: MESSAGES, stream: true }, { signal: controller.signal });
    assert.equal(res.status, 200);
    controller.abort();

    await proxy.waitForLog('Client disconnected before the reply finished', 2000);
    await waitFor(() => nim.disconnects() === 1, 'NVIDIA connection was not closed');
  });
});

// ─── Odd replies ───────────────────────────────────────────────────────────

describe('a reply that mentions [DONE]', () => {
  let nim;
  let proxy;
  const answer = 'The sign on the door said [DONE] in red paint, and the story went on.';

  before(async () => {
    // One chunk, so a single line carries the whole word
    nim = await startMockNim({ answer, chunkSize: 1000 });
    proxy = await startProxy(nim.url, { SKIP_VALIDATION: 'true' });
  });
  after(async () => {
    await proxy?.stop();
    await nim?.close();
  });

  it('streams the whole reply instead of stopping at the word', async () => {
    const res = await chat(proxy, { model: 'deepseek-v4.1-flash', messages: MESSAGES, stream: true });
    assert.equal(streamedContent(parseSse(await res.text())), answer);
  });
});

// ─── Instructions and lorebooks ────────────────────────────────────────────

describe('instructions and lorebook files', () => {
  let nim;
  let proxy;
  let dir;

  const LOREBOOK = {
    name: 'Vel Arun',
    entries: [
      { name: 'Harbor', keys: ['harbor'], content: 'LORE: the harbor freezes never.', insertion_order: 10 },
      { name: 'Bells', keys: ['bells'], content: 'LORE: the bells ring underwater.', insertion_order: 20 },
      { name: 'Magic', keys: [], constant: true, content: 'LORE: magic is rare.', insertion_order: 5, position: 'before_char' }
    ]
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-prompts-'));
    fs.writeFileSync(path.join(dir, 'instructions.md'), 'Stay in character. Never speak for the user.\n');
    fs.writeFileSync(path.join(dir, 'lorebook.json'), JSON.stringify(LOREBOOK));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    nim = await startMockNim();
    proxy = await startProxy(nim.url, {
      SKIP_VALIDATION: 'true',
      INSTRUCTIONS_PATH: path.join(dir, 'instructions.md'),
      LOREBOOK_PATH: dir
    });
  });
  after(async () => {
    await proxy?.stop();
    await nim?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('logs what it loaded and skips a broken file without crashing', () => {
    const logs = proxy.logs();
    assert.ok(logs.includes('[PROMPTS] Instructions: 44 chars'), logs);
    assert.ok(logs.includes('[LORE] Loaded "Vel Arun" (3 entries)'), logs);
    assert.match(logs, /\[LORE\] Skipped .*broken\.json/);
  });

  it('adds matching lore to the system prompt and the instructions at the end', async () => {
    const res = await chat(proxy, {
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'You are Mira.' },
        { role: 'user', content: 'We walk down to the Harbor.' }
      ]
    });
    assert.equal(res.status, 200);

    const sent = nim.lastRequest().messages;
    assert.equal(sent.length, 3);
    assert.equal(sent[0].content, 'LORE: magic is rare.\n\nYou are Mira.\n\nLORE: the harbor freezes never.');
    assert.deepEqual(sent[1], { role: 'user', content: 'We walk down to the Harbor.' });
    assert.deepEqual(sent[2], { role: 'system', content: 'Stay in character. Never speak for the user.' });
    assert.ok(proxy.logs().includes('[LORE] Added 2: Magic, Harbor'), proxy.logs());
  });

  it('leaves out entries whose keywords are not in the recent messages', async () => {
    await chat(proxy, { model: 'glm-5.3', messages: [{ role: 'user', content: 'Hello there.' }] });
    const sent = nim.lastRequest().messages;
    assert.equal(sent[0].role, 'system');
    assert.equal(sent[0].content, 'LORE: magic is rare.');
    assert.ok(!JSON.stringify(sent).includes('harbor freezes'));
  });
});

// ─── Small helpers for the tests above ─────────────────────────────────────

async function waitFor(check, message, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) assert.fail(message);
    await new Promise(r => setTimeout(r, 20));
  }
}
