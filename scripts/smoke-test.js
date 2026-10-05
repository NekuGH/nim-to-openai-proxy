// scripts/smoke-test.js — Live check of a running proxy against real NVIDIA NIM.
//
// Usage:
//   PROXY_URL=https://your-app.up.railway.app CLIENT_AUTH_KEY=your-key npm run smoke
//
// PROXY_URL defaults to http://localhost:3000. MODELS picks which aliases to
// try (comma-separated); by default it tries the three models below. Each one
// is asked for a one-word reply, once normally and once streamed.

const PROXY_URL = (process.env.PROXY_URL || 'http://localhost:3000').replace(/\/+$/, '');
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY;
const MODELS = (process.env.MODELS || 'deepseek-v4.1-flash,glm-5.3,glm-5.3-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean);

// A bit longer than the proxy's own 180s upstream timeout
const TIMEOUT_MS = 200000;

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

async function post(body) {
  return fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLIENT_AUTH_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

async function errorText(res) {
  const raw = await res.text();
  try {
    return JSON.parse(raw).error?.message || raw;
  } catch {
    return raw;
  }
}

async function checkPlain(model) {
  const started = Date.now();
  const res = await post({ model, messages: MESSAGES, max_tokens: 64 });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await errorText(res)}`);

  const body = await res.json();
  const content = body.choices?.[0]?.message?.content || '';
  const finish = body.choices?.[0]?.finish_reason;
  if (!content.trim()) throw new Error(`empty reply (finish_reason: ${finish})`);
  if (leakedThinking(content)) throw new Error(`thinking leaked into reply: ${preview(content)}`);

  return `${Date.now() - started} ms, "${preview(content)}"`;
}

async function checkStream(model) {
  const started = Date.now();
  const res = await post({ model, messages: MESSAGES, max_tokens: 64, stream: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await errorText(res)}`);

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let firstTextMs = null;
  let done = false;

  for await (const bytes of res.body) {
    buffer += decoder.decode(bytes, { stream: true });
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

  const health = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(15000) })
    .then(r => r.json())
    .catch(err => ({ error: err.message }));
  console.log(`/health: ${JSON.stringify(health)}`);

  const listed = await fetch(`${PROXY_URL}/v1/models`, { signal: AbortSignal.timeout(15000) })
    .then(r => r.json())
    .then(b => b.data.map(m => m.id))
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
        const reason = err.name === 'TimeoutError' ? `no reply within ${TIMEOUT_MS / 1000}s` : err.message;
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
