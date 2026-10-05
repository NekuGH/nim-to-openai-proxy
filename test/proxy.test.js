// test/proxy.test.js — Runs the real server.js against the mock NIM upstream.
// Run with: npm test

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

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
    'GLM_REASONING_EFFORT', 'DEEPSEEK_REASONING_EFFORT']) {
    delete env[k];
  }
  Object.assign(env, {
    PORT: String(port),
    NIM_API_BASE: nimUrl,
    NIM_API_KEY: NIM_KEY,
    CLIENT_AUTH_KEY: CLIENT_KEY
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

function chat(proxy, body, { auth = CLIENT_KEY } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  return fetch(`${proxy.url}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

// Parses an SSE body into its JSON chunks, checking framing as it goes
function parseSse(text) {
  const frames = text.split('\n\n').filter(f => f.length > 0);
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

  it('serves the renamed aliases and no longer accepts the old names', async () => {
    for (const [alias, nimId] of [['nemotron-3-ultra', 'nvidia/nemotron-3-ultra-550b-a55b'], ['glm-5.3', 'z-ai/glm-5.3']]) {
      const res = await chat(proxy, { model: alias, messages: MESSAGES });
      assert.equal(res.status, 200);
      assert.equal(nim.lastRequest().model, nimId);
    }
    for (const oldName of ['gpt-4', 'glm-5.2']) {
      const res = await chat(proxy, { model: oldName, messages: MESSAGES });
      assert.equal(res.status, 400, `${oldName} should be gone`);
    }
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
