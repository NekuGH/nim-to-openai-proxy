// scripts/nim-probe.js — Measures how NVIDIA NIM really behaves for the
// proxy's thinking-tuned models, so timeouts and retries can be set from data
// instead of guesses. Talks to NIM directly (not through the proxy) and sends
// the same per-model options server.js does.
//
// Usage:
//   NIM_API_KEY=nvapi-... npm run probe
//
// Options (environment variables):
//   PROFILES   comma-separated profile names (default: all, see PROFILES below)
//   SIZES      short,long — prompt sizes to try (default: both)
//   MODES      stream,plain — streamed and/or non-streamed (default: both)
//   RUNS       rounds over every combination (default 3)
//   GAP_MS     pause between requests, to stay under the rate limit (default 3000)
//   HARD_TIMEOUT_MS  give up on one request after this long (default 600000,
//              longer than the proxy's 480 s so slower answers still show up)
//   BURST      fire this many short requests at once at the first profile
//              instead, to see how rate limiting answers (default off)
//   OUT        JSON-lines file every result is appended to
//              (default nim-probe-results.jsonl)
//
// Uses axios (as server.js does) rather than fetch: Node's fetch gives up by
// itself after 300 s, and axios also follows HTTPS_PROXY when one is set.

const fs = require('fs');
const axios = require('axios');

const NIM_API_BASE = (process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const NIM_API_KEY = process.env.NIM_API_KEY;

const RUNS = Number(process.env.RUNS || 3);
const GAP_MS = Number(process.env.GAP_MS || 3000);
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS || 600000);
const BURST = Number(process.env.BURST || 0);
const OUT = process.env.OUT || 'nim-probe-results.jsonl';
const list = (value, fallback) => (value ? value.split(',').map(s => s.trim()).filter(Boolean) : fallback);

// Reply budget for one RP turn; thinking profiles get the proxy's headroom on top
const REPLY_TOKENS = 400;
const HEADROOM = { low: 4096, high: 8192, max: 16384 };

const glm = effort => ({ reasoning_effort: effort, clear_thinking: true });

const PROFILES = {
  'ds41-off': {
    model: 'deepseek-ai/deepseek-v4.1-flash',
    kwargs: { thinking: false, enable_thinking: false },
    maxTokens: REPLY_TOKENS
  },
  'ds41-high': {
    model: 'deepseek-ai/deepseek-v4.1-flash',
    kwargs: { thinking: true, enable_thinking: true, reasoning_effort: 'high' },
    maxTokens: REPLY_TOKENS + HEADROOM.high
  },
  // No chat_template_kwargs at all: checks the reported NIM hang
  'ds41-bare': {
    model: 'deepseek-ai/deepseek-v4.1-flash',
    kwargs: undefined,
    maxTokens: REPLY_TOKENS
  },
  'glm53-low': { model: 'z-ai/glm-5.3', kwargs: glm('low'), maxTokens: REPLY_TOKENS + HEADROOM.low },
  'glm53-high': { model: 'z-ai/glm-5.3', kwargs: glm('high'), maxTokens: REPLY_TOKENS + HEADROOM.high },
  'glm53f-low': { model: 'z-ai/glm-5.3-flash', kwargs: glm('low'), maxTokens: REPLY_TOKENS + HEADROOM.low },
  'glm53f-high': { model: 'z-ai/glm-5.3-flash', kwargs: glm('high'), maxTokens: REPLY_TOKENS + HEADROOM.high }
};

const profileNames = list(process.env.PROFILES, Object.keys(PROFILES));
const sizes = list(process.env.SIZES, ['short', 'long']);
const modes = list(process.env.MODES, ['stream', 'plain']);

for (const name of profileNames) {
  if (!PROFILES[name]) {
    console.error(`Unknown profile "${name}". Known: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(2);
  }
}
if (!NIM_API_KEY) {
  console.error('Set NIM_API_KEY (a key from build.nvidia.com).');
  process.exit(2);
}

// ─── Prompts ───────────────────────────────────────────────────────────────

const LORE = [
  'The harbor city of Vel Arun clings to black cliffs above a sea that never freezes.',
  'Lanterns of whale oil burn along the switchback stairs that link the docks to the upper wards.',
  'The Tidewardens keep the old breakwater and answer to no guild, only to the drowned bells.',
  'Mira, the narrator\'s companion, is a former smuggler with a ledger of debts she never repays.',
  'Rain in Vel Arun tastes of salt and copper, and the locals swear it carries whispers.',
  'Every seventh night the bells ring beneath the water, and the fishing fleet stays ashore.',
  'The Archivist trades secrets for memories, and keeps both in jars of cloudy glass.',
  'A war with the inland baronies ended a decade ago, but the scars run through every family.'
];

// A unique tag at the very start keeps NIM's prefix cache from making the
// long prompt look faster than a fresh conversation would be.
function messagesFor(size) {
  const nonce = `[session ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}]`;
  const ask = 'Continue the scene in about 150 words, in third person, past tense.';

  if (size === 'short') {
    return [
      { role: 'system', content: `${nonce} You are the narrator of a fantasy roleplay.` },
      { role: 'user', content: `Mira pushes open the door of the flooded archive. ${ask}` }
    ];
  }

  // About 6k tokens of character card, lore and chat history, like a
  // JanitorAI / SillyTavern request a few dozen messages into a chat
  const lore = [];
  for (let i = 0; i < 120; i++) lore.push(`${i + 1}. ${LORE[i % LORE.length]}`);
  const history = [];
  for (let i = 0; i < 16; i++) {
    history.push({ role: 'user', content: `Turn ${i + 1}: Mira studies the ledger and asks about the bells. ${LORE[(i * 3) % LORE.length]}` });
    history.push({ role: 'assistant', content: `The narrator describes the scene (turn ${i + 1}). ${LORE[(i * 5 + 1) % LORE.length]} ${LORE[(i * 7 + 2) % LORE.length]}` });
  }
  return [
    { role: 'system', content: `${nonce} You are the narrator of a fantasy roleplay.\n\nWorld notes:\n${lore.join('\n')}` },
    ...history,
    { role: 'user', content: `Mira pushes open the door of the flooded archive. ${ask}` }
  ];
}

// ─── One request ───────────────────────────────────────────────────────────

const INTERESTING_HEADER = /ratelimit|retry-after|request-id|nvcf/i;

function pickHeaders(headers) {
  const picked = {};
  for (const [k, v] of Object.entries(headers.toJSON())) if (INTERESTING_HEADER.test(k)) picked[k] = v;
  return picked;
}

async function readAll(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts).toString('utf8');
}

async function probeOnce(profileName, size, mode) {
  const profile = PROFILES[profileName];
  const stream = mode === 'stream';
  const body = {
    model: profile.model,
    messages: messagesFor(size),
    temperature: 0.7,
    max_tokens: profile.maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(profile.kwargs ? { chat_template_kwargs: profile.kwargs } : {})
  };

  const result = {
    at: new Date().toISOString(),
    profile: profileName,
    model: profile.model,
    size,
    mode,
    ok: false,
    status: null,
    error: null,
    tHeaders: null,
    tFirstEvent: null,
    tFirstReasoning: null,
    tFirstContent: null,
    tEnd: null,
    maxGap: null,
    reasoningField: null,
    reasoningChars: 0,
    contentChars: 0,
    leakedThink: false,
    finishReason: null,
    usage: null,
    headers: {}
  };

  const started = Date.now();
  const since = () => Date.now() - started;
  const controller = new AbortController();
  let lastEventAt = null;
  const hardTimer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);

  const noteDelta = (delta) => {
    const field = ['reasoning_content', 'reasoning'].find(f => typeof delta?.[f] === 'string' && delta[f]);
    if (field) {
      result.reasoningField = field;
      result.reasoningChars += delta[field].length;
      if (result.tFirstReasoning === null) result.tFirstReasoning = since();
    }
    if (typeof delta?.content === 'string' && delta.content) {
      result.contentChars += delta.content.length;
      if (/<\/?think>/.test(delta.content)) result.leakedThink = true;
      if (result.tFirstContent === null) result.tFirstContent = since();
    }
  };

  try {
    const res = await axios.post(`${NIM_API_BASE}/chat/completions`, body, {
      headers: {
        Authorization: `Bearer ${NIM_API_KEY}`,
        Accept: stream ? 'text/event-stream' : 'application/json'
      },
      responseType: 'stream',
      validateStatus: () => true,
      signal: controller.signal
    });
    result.tHeaders = since();
    result.status = res.status;
    result.headers = pickHeaders(res.headers);

    if (res.status < 200 || res.status >= 300) {
      const text = await readAll(res.data);
      result.tEnd = since();
      result.error = `http_${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`;
      return result;
    }

    if (!stream) {
      const data = JSON.parse(await readAll(res.data));
      result.tEnd = since();
      const choice = data.choices?.[0];
      noteDelta(choice?.message);
      result.finishReason = choice?.finish_reason ?? null;
      result.usage = data.usage ?? null;
      result.ok = result.contentChars > 0;
      if (!result.ok) result.error = 'empty_content';
      return result;
    }

    res.data.setEncoding('utf8');
    let buffer = '';
    lastEventAt = result.tHeaders;
    let sawDone = false;
    result.maxGap = 0;

    for await (const text of res.data) {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const now = since();
        result.maxGap = Math.max(result.maxGap, now - lastEventAt);
        lastEventAt = now;
        if (result.tFirstEvent === null) result.tFirstEvent = now;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          sawDone = true;
          continue;
        }
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          result.error = `bad_json: ${payload.slice(0, 120)}`;
          continue;
        }
        if (data.error) result.error = `stream_error: ${JSON.stringify(data.error).slice(0, 200)}`;
        if (data.usage) result.usage = data.usage;
        const choice = data.choices?.[0];
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
        noteDelta(choice?.delta);
      }
    }

    result.tEnd = since();
    if (!sawDone && !result.error) result.error = 'no_done';
    if (result.contentChars === 0 && !result.error) result.error = 'empty_content';
    result.ok = !result.error;
    return result;

  } catch (err) {
    result.tEnd = since();
    if (controller.signal.aborted) {
      result.error = result.tHeaders === null ? 'hard_timeout_before_headers' : 'hard_timeout_mid_body';
      // The silence that made us give up counts as a gap too
      if (lastEventAt !== null) result.maxGap = Math.max(result.maxGap ?? 0, result.tEnd - lastEventAt);
    } else {
      result.error = `network: ${err.code || err.message}`;
    }
    return result;
  } finally {
    clearTimeout(hardTimer);
  }
}

// ─── Reporting ─────────────────────────────────────────────────────────────

function record(result) {
  fs.appendFileSync(OUT, `${JSON.stringify(result)}\n`);
  const secs = v => (v === null ? '   -  ' : `${(v / 1000).toFixed(1).padStart(5)}s`);
  console.log([
    result.ok ? 'ok  ' : 'FAIL',
    result.profile.padEnd(11),
    result.size.padEnd(5),
    result.mode.padEnd(6),
    `hdr ${secs(result.tHeaders)}`,
    `think ${secs(result.tFirstReasoning)}`,
    `text ${secs(result.tFirstContent)}`,
    `end ${secs(result.tEnd)}`,
    `gap ${secs(result.maxGap)}`,
    `out ${result.usage?.completion_tokens ?? '?'}tok`,
    result.finishReason ?? '',
    result.error ?? ''
  ].join('  '));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.profile} ${r.size} ${r.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const fmt = v => (v === null ? '-' : (v / 1000).toFixed(1));
  const stat = (rs, field) => {
    const vals = rs.map(r => r[field]).filter(v => v !== null);
    return `${fmt(percentile(vals, 50))}/${fmt(percentile(vals, 90))}/${fmt(vals.length ? Math.max(...vals) : null)}`;
  };

  console.log('\nSummary — seconds as median/p90/max, over successful and failed requests alike');
  console.log('group                       ok    headers        first text     end            max gap        errors');
  for (const [key, rs] of groups) {
    const ok = rs.filter(r => r.ok).length;
    const errors = {};
    for (const r of rs.filter(r => r.error)) {
      const kind = r.error.split(':')[0];
      errors[kind] = (errors[kind] || 0) + 1;
    }
    console.log([
      key.padEnd(27),
      `${ok}/${rs.length}`.padEnd(5),
      stat(rs, 'tHeaders').padEnd(14),
      stat(rs, 'tFirstContent').padEnd(14),
      stat(rs, 'tEnd').padEnd(14),
      stat(rs, 'maxGap').padEnd(14),
      Object.entries(errors).map(([k, n]) => `${k}×${n}`).join(' ')
    ].join(' '));
  }
  console.log(`\nRaw results appended to ${OUT}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function runBurst() {
  const profileName = profileNames[0];
  console.log(`Burst: ${BURST} parallel short streamed requests to ${profileName}\n`);
  const results = await Promise.all(
    Array.from({ length: BURST }, () => probeOnce(profileName, 'short', 'stream'))
  );
  results.forEach(record);
  const limited = results.filter(r => r.status === 429);
  if (limited.length) console.log(`\n429 headers: ${JSON.stringify(limited[0].headers)}`);
  summarize(results);
}

async function runMatrix() {
  const combos = [];
  for (const size of sizes) {
    for (const mode of modes) {
      for (const name of profileNames) combos.push([name, size, mode]);
    }
  }
  console.log(`NIM: ${NIM_API_BASE}`);
  console.log(`${RUNS} round(s) × ${combos.length} combinations, ${GAP_MS} ms apart\n`);

  const results = [];
  for (let run = 0; run < RUNS; run++) {
    // Same order every round, so slow periods hit every combination alike
    for (const [name, size, mode] of combos) {
      const result = await probeOnce(name, size, mode);
      results.push(result);
      record(result);
      await new Promise(r => setTimeout(r, GAP_MS));
    }
  }
  summarize(results);
}

(BURST > 0 ? runBurst() : runMatrix()).catch(err => {
  console.error(err);
  process.exit(1);
});
