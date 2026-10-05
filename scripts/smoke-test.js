// scripts/smoke-test.js — Live check of a running proxy against real NVIDIA NIM.
//
// Usage:
//   PROXY_URL=https://your-app.up.railway.app CLIENT_AUTH_KEY=your-key npm run smoke
//
// PROXY_URL defaults to http://localhost:3000. MODELS picks which aliases to
// try (comma-separated); by default it tries the three models below. Each one
// is asked for a one-word reply, once normally and once streamed.

const axios = require('axios');

const PROXY_URL = (process.env.PROXY_URL || 'http://localhost:3000').replace(/\/+$/, '');
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY;
const MODELS = (process.env.MODELS || 'deepseek-v4.1-flash,glm-5.3,glm-5.3-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

// A bit longer than the proxy's own 480 s upstream timeout. axios rather than
// fetch, because Node's fetch gives up by itself after 300 s.
const TIMEOUT_MS = 500000;

const MESSAGES = [{ role: 'user', content: 'Reply with the single word: pong' }];

if (!CLIENT_AUTH_KEY) {
  console.error('Set CLIENT_AUTH_KEY to the key your proxy expects.');
  process.exit(2);
}

function leakedThinking(text) {
  // <thinking> is the proxy's own SHOW_REASONING wrapper; raw tags mean a leak
  return /<\/?think>/.test(text);
}

function preview(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

function post(body) {
  return axios.post(`${PROXY_URL}/v1/chat/completions`, body, {
    headers: { Authorization: `Bearer ${CLIENT_AUTH_KEY}` },
    responseType: 'stream',
    validateStatus: () => true,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

async function readAll(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts).toString('utf8');
}

async function errorText(res) {
  const raw = await readAll(res.data);
  try {
    return JSON.parse(raw).error?.message || raw;
  } catch {
    return raw;
  }
}

async function checkPlain(model) {
  const started = Date.now();
  const res = await post({ model, messages: MESSAGES, max_tokens: 64 });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${await errorText(res)}`);

  const body = JSON.parse(await readAll(res.data));
  const content = body.choices?.[0]?.message?.content || '';
  const finish = body.choices?.[0]?.finish_reason;
  if (!content.trim()) throw new Error(`empty reply (finish_reason: ${finish})`);
  if (leakedThinking(content)) throw new Error(`thinking leaked into reply: ${preview(content)}`);

  return `${Date.now() - started} ms, "${preview(content)}"`;
}

async function checkStream(model) {
  const started = Date.now();
  const res = await post({ model, messages: MESSAGES, max_tokens: 64, stream: true });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${await errorText(res)}`);

  res.data.setEncoding('utf8');
  let buffer = '';
  let content = '';
  let firstTextMs = null;
  let done = false;

  for await (const text of res.data) {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') {
        done = true;
        continue;
      }
      const data = JSON.parse(payload);
      if (data.error) throw new Error(`stream error: ${data.error.message}`);
      const piece = data.choices?.[0]?.delta?.content || '';
      if (piece && firstTextMs === null) firstTextMs = Date.now() - started;
      content += piece;
    }
  }

  if (!done) throw new Error('stream ended without [DONE]');
  if (!content.trim()) throw new Error('empty streamed reply');
  if (leakedThinking(content)) throw new Error(`thinking leaked into reply: ${preview(content)}`);

  return `first text ${firstTextMs} ms, total ${Date.now() - started} ms, "${preview(content)}"`;
}

async function main() {
  console.log(`Proxy: ${PROXY_URL}\n`);

  const health = await axios.get(`${PROXY_URL}/health`, { timeout: 15000 })
    .then(r => r.data)
    .catch(err => ({ error: err.message }));
  console.log(`/health: ${JSON.stringify(health)}`);

  const listed = await axios.get(`${PROXY_URL}/v1/models`, { timeout: 15000 })
    .then(r => r.data.data.map(m => m.id))
    .catch(() => []);
  const missing = MODELS.filter(m => !listed.includes(m));
  if (missing.length) {
    console.log(`Not offered by this proxy (redeploy the latest code?): ${missing.join(', ')}`);
  }
  console.log('');

  let failures = 0;
  for (const model of MODELS) {
    for (const [label, check] of [['plain ', checkPlain], ['stream', checkStream]]) {
      try {
        console.log(`PASS  ${model.padEnd(20)} ${label}  ${await check(model)}`);
      } catch (err) {
        failures++;
        const reason = err.code === 'ERR_CANCELED' ? `no reply within ${TIMEOUT_MS / 1000}s` : err.message;
        console.log(`FAIL  ${model.padEnd(20)} ${label}  ${reason}`);
      }
    }
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
