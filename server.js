// server.js — Robust Hybrid OpenAI ↔ NIM Proxy
// Express 5 Compatible
// Fixes: auth bypass, startup DDoS, silent stream failures, memory leaks, Express 5 deprecations

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const { timingSafeEqual } = require('crypto');
const { loadPromptAdditions, applyPromptAdditions } = require('./prompts');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Configuration ───────────────────────────────────────────────────────────

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY;

const SHOW_REASONING = process.env.SHOW_REASONING === 'true';
const ENABLE_THINKING_MODE = process.env.ENABLE_THINKING_MODE === 'true';
const SKIP_VALIDATION = process.env.SKIP_VALIDATION === 'true';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const GLM_REASONING_EFFORT = ['low', 'high', 'max'].includes(process.env.GLM_REASONING_EFFORT)
  ? process.env.GLM_REASONING_EFFORT
  : 'low';
const DEEPSEEK_REASONING_EFFORT = ['low', 'high', 'max'].includes(process.env.DEEPSEEK_REASONING_EFFORT)
  ? process.env.DEEPSEEK_REASONING_EFFORT
  : 'high';

const MAX_TOKENS_LIMIT = 65536;
// Render sets RENDER_GIT_COMMIT on every deploy, so the log and /health show
// which version is running
const DEPLOYED_COMMIT = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'unknown';

// Milliseconds from an env var, or the fallback when it isn't a whole number in
// range. Node timers can't hold more than 2^31-1 ms; beyond that they fire at once.
const MAX_TIMER_MS = 2147483647;
function envMs(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n <= MAX_TIMER_MS && (n > 0 || (allowZero && n === 0))) return n;
  console.warn(`[CONFIG] Ignoring ${name}=${raw}: expected whole milliseconds${allowZero ? ' (0 to turn off)' : ''} up to ${MAX_TIMER_MS}`);
  return fallback;
}

// How long to wait on NIM, for every model: both for it to start answering and
// for the longest silence mid-stream (a stream that keeps sending has no cap).
// NVIDIA's free tier is often overloaded and can queue a request for minutes.
const REQUEST_TIMEOUT_MS = envMs('REQUEST_TIMEOUT_MS', 480000);
const VALIDATION_TIMEOUT_MS = 15000;
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB
// While NVIDIA queues a request the client hears nothing, and whatever sits in
// between gives up: Render's Cloudflare edge drops a request that hasn't
// started answering within ~100 s, and the browser then only reports a vague
// "NetworkError". So after this much silence the reply is started early and
// kept alive with filler clients ignore: an SSE comment line when streaming
// (OpenRouter does the same), a newline before the JSON otherwise (JSON
// allows leading whitespace). 0 turns it off.
const KEEPALIVE_MS = envMs('KEEPALIVE_MS', 15000, { allowZero: true });

console.log(`[CONFIG] Upstream timeout: ${REQUEST_TIMEOUT_MS / 1000}s`);
console.log(KEEPALIVE_MS > 0
  ? `[CONFIG] Keep-alive: every ${KEEPALIVE_MS / 1000}s of silence`
  : '[CONFIG] Keep-alive: OFF');
if (SHOW_REASONING) console.log('[CONFIG] Reasoning display: ENABLED');
if (ENABLE_THINKING_MODE) console.log('[CONFIG] Thinking mode: ENABLED');
console.log(`[CONFIG] GLM-5.3 / GLM-5.3-Flash reasoning effort: ${GLM_REASONING_EFFORT}`);
console.log(ENABLE_THINKING_MODE
  ? `[CONFIG] DeepSeek-V4.1-Flash thinking: ON (effort ${DEEPSEEK_REASONING_EFFORT})`
  : '[CONFIG] DeepSeek-V4.1-Flash thinking: OFF');

// ─── Config validation ──────────────────────────────────────────────────────

function validateConfig() {
  const fatal = (msg) => { console.error(`[FATAL] ${msg}`); process.exit(1); };
  
  if (!NIM_API_KEY) fatal('NIM_API_KEY is required. Get one at https://build.nvidia.com/');
  
  if (!CLIENT_AUTH_KEY) {
    console.warn('[WARN] CLIENT_AUTH_KEY not set. All requests will be rejected with 403.');
  }
}

validateConfig();

// Fixed instructions and lorebooks, read once from files (see prompts.js)
const PROMPT_ADDITIONS = loadPromptAdditions();

// ─── Model Mapping ─────────────────────────────────────────────────────────

const MODEL_MAPPING = {
  'nemotron-3-ultra': 'nvidia/nemotron-3-ultra-550b-a55b',
  'nemotron-3-super': 'nvidia/nemotron-3-super-120b-a12b',
  'nemotron-3.5-lightning': 'nvidia/nemotron-3.5-lightning-30b-a3b',
  'deepseek-v4.1-flash': 'deepseek-ai/deepseek-v4.1-flash',
  'glm-5.3': 'z-ai/glm-5.3',
  'glm-5.3-flash': 'z-ai/glm-5.3-flash'
};

// Names this proxy used to accept. A client still sending one is told what to
// switch to instead of getting a bare "Unknown model".
const OLD_MODEL_NAMES = {
  'gpt-4': { now: 'nemotron-3-ultra' },
  'gpt-3.5-turbo': { now: 'nemotron-3-super' },
  'glm-5.2': { now: 'glm-5.3' },
  'gpt-4o': { retired: 'deepseek-ai/deepseek-v4-pro-0813', try: 'deepseek-v4.1-flash' },
  'gpt-4-flash': { retired: 'deepseek-ai/deepseek-v4-flash', try: 'deepseek-v4.1-flash' },
  'gemini-pro': { retired: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', try: 'nemotron-3.5-lightning' },
  'gpt-3.5o': { retired: 'nvidia/nemotron-mini-4b-instruct', try: 'nemotron-3.5-lightning' }
};

// ─── Per-model request options ─────────────────────────────────────────────

// Thinking counts against max_tokens, so extra room is added for it.
const REASONING_TOKENS = { low: 4096, high: 8192, max: 16384 };

// GLM-5.3 and GLM-5.3-Flash share a chat template that always thinks before
// answering; it has no off switch. Never send enable_thinking: false to them —
// the template ignores it and the reasoning then leaks into the reply.
// reasoning_effort (low/high/max, default max) controls how long they think;
// clear_thinking is Z.ai's advice for chat.
const GLM_OPTIONS = {
  chat_template_kwargs: {
    reasoning_effort: GLM_REASONING_EFFORT,
    clear_thinking: true
  },
  reasoningTokens: REASONING_TOKENS[GLM_REASONING_EFFORT]
};

// DeepSeek-V4.1-Flash thinks unless told not to, and NIM DeepSeek V4 requests
// can hang with no reply at all when chat_template_kwargs is missing, so the
// switch is always sent explicitly. Serving stacks disagree on its name
// (SGLang reads "thinking", the model's own template reads "enable_thinking"),
// so both are set. reasoning_effort is only sent while thinking, and only as
// low/high/max — every stack accepts those, while "medium" and "xhigh" each
// break on one of them.
const DEEPSEEK_V41_OPTIONS = ENABLE_THINKING_MODE
  ? {
    chat_template_kwargs: {
      thinking: true,
      enable_thinking: true,
      reasoning_effort: DEEPSEEK_REASONING_EFFORT
    },
    reasoningTokens: REASONING_TOKENS[DEEPSEEK_REASONING_EFFORT]
  }
  : {
    chat_template_kwargs: {
      thinking: false,
      enable_thinking: false
    }
  };

const MODEL_OPTIONS = {
  'z-ai/glm-5.3': GLM_OPTIONS,
  'z-ai/glm-5.3-flash': GLM_OPTIONS,
  'deepseek-ai/deepseek-v4.1-flash': DEEPSEEK_V41_OPTIONS
};

// ─── Middleware ─────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// FIX: Extract token AFTER "Bearer " prefix, compare only the token
// Prevents bypass when CLIENT_AUTH_KEY is empty (expected would be "Bearer " which is 7 chars)
function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const parts = authHeader.trim().split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

function safeTimingEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/v1/models') {
    return next();
  }

  const token = extractBearerToken(req.headers.authorization);
  
  if (!token || !CLIENT_AUTH_KEY) {
    return res.status(403).json({
      error: {
        message: 'Forbidden: Invalid or missing authentication',
        type: 'authentication_error',
        code: 403
      }
    });
  }

  if (!safeTimingEqual(token, CLIENT_AUTH_KEY)) {
    return res.status(403).json({
      error: {
        message: 'Forbidden: Invalid authentication credentials',
        type: 'authentication_error',
        code: 403
      }
    });
  }

  next();
});

// ─── Validation ─────────────────────────────────────────────────────────────

// FIX: Use lightweight model listing instead of burning inference quota
// If NIM doesn't support /models, skip validation entirely rather than DDoS-ing yourself
async function validateModels() {
  if (SKIP_VALIDATION) {
    console.log('[VALIDATION] Skipped (SKIP_VALIDATION=true)');
    return;
  }

  console.log('[VALIDATION] Checking model availability via /v1/models...');

  try {
    const response = await axios.get(`${NIM_API_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: VALIDATION_TIMEOUT_MS
    });

    const availableModels = new Set(
      (response.data.data || []).map(m => m.id)
    );

    const invalid = [];
    
    for (const [alias, nimId] of Object.entries(MODEL_MAPPING)) {
      if (availableModels.has(nimId)) {
        console.log(`[VALIDATION] ✓ ${alias} → ${nimId}`);
      } else {
        console.warn(`[VALIDATION] ✗ ${alias} → ${nimId} (not in catalog)`);
        invalid.push({ alias, nimId, error: 'Model not found in NIM catalog' });
      }
    }

    if (invalid.length > 0) {
      await sendDiscordAlert(invalid);
    } else {
      console.log('[VALIDATION] All models valid.');
    }

  } catch (err) {
    console.warn(`[VALIDATION] /v1/models endpoint failed: ${err.message}. Skipping validation.`);
    console.warn('[VALIDATION] Consider setting SKIP_VALIDATION=true if your NIM provider lacks a model listing endpoint.');
  }
}

async function sendDiscordAlert(invalidModels) {
  if (!DISCORD_WEBHOOK_URL) return;

  const embed = {
    title: '⚠️ NIM Proxy: Model Validation Failed',
    description: `${invalidModels.length} model(s) failed validation. Check NIM catalog for deprecations.`,
    color: 0xff4444,
    timestamp: new Date().toISOString(),
    fields: invalidModels.map(m => ({
      name: `\`${m.alias}\``,
      value: `Backend: \`${m.nimId}\`\nError: \`${m.error}\``,
      inline: true
    }))
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [embed],
      username: 'NIM Proxy Monitor'
    }, { timeout: 5000 });
    console.log('[DISCORD] Alert sent.');
  } catch (err) {
    console.error('[DISCORD] Failed to send alert:', err.message);
  }
}

// ─── Helper: Safe Stream Writing ───────────────────────────────────────────

// FIX: Wrap res.write in try/catch to prevent crashes on closed sockets
function safeWrite(res, data) {
  try {
    if (!res.writableEnded && !res.destroyed && res.writable) {
      res.write(data);
      return true;
    }
  } catch (err) {
    console.warn('[STREAM] Write failed:', err.message);
  }
  return false;
}

// ─── Helper: Upstream Call ──────────────────────────────────────────────────

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// On streamed requests NIM's error body arrives as a stream; read a little of
// it so the client and the log get NVIDIA's actual message.
async function readStreamText(stream, maxBytes = 65536, timeoutMs = 5000) {
  return new Promise(resolve => {
    let text = '';
    const finish = () => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      resolve(text);
    };
    const timer = setTimeout(() => { stream.destroy(); finish(); }, timeoutMs);
    stream.setEncoding?.('utf8');
    stream.on('data', part => {
      text += part;
      if (text.length >= maxBytes) { stream.destroy(); finish(); }
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

async function describeUpstreamError(err) {
  let body = err.response?.data;
  err.nimBodyBytes = 0;
  if (body === undefined || body === null) return err.message;
  if (typeof body.on === 'function') {
    body = await readStreamText(body);
    err.nimBodyBytes = Buffer.byteLength(body);
    try { body = JSON.parse(body); } catch { /* plain text */ }
  } else {
    err.nimBodyBytes = Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body));
  }
  if (typeof body === 'string') return body.trim().slice(0, 500) || err.message;
  // NIM answers in a few shapes: OpenAI-style, NVCF problem+json, or vLLM's
  const message = body?.error?.message || body?.detail || body?.message || body?.title;
  return typeof message === 'string' ? message : JSON.stringify(body).slice(0, 500);
}

// Facts about a failed NVIDIA answer, for the log: enough to tell an empty
// error body from a lost one, and NVIDIA's request id to quote to their
// support. Never includes the API key or any chat text.
function failureFacts(err, requestBytes, messageCount) {
  const raw = err.response?.headers;
  const headers = typeof raw?.toJSON === 'function' ? raw.toJSON() : (raw || {});
  const facts = [];
  for (const name of ['content-type', 'content-length', 'content-encoding', 'location']) {
    if (headers[name]) facts.push(`${name}=${headers[name]}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (/req-?id|request-id/i.test(name)) facts.push(`${name}=${value}`);
  }
  if (err.response) facts.push(`body=${err.nimBodyBytes ?? 0} B`);
  facts.push(`sent=${(requestBytes / 1024).toFixed(1)} KB in ${messageCount} messages`);
  return `[${facts.join(', ')}]`;
}

// NVIDIA is busy: wait a moment and ask the same model again
const RATE_LIMIT_STATUSES = [429, 529];
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_DELAY_MS = 4000;
// A hiccup between us and the model (a model briefly not served, a backend
// fault, bad gateway, briefly unavailable, dropped connection): one more try,
// but only when it failed quickly — a gateway timeout after minutes in
// NVIDIA's queue is not worth waiting through twice
const HICCUP_STATUSES = [404, 500, 502, 503, 504];
const HICCUP_CODES = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'];
const HICCUP_RETRIES = 1;
const HICCUP_DELAY_MS = 2000;
// "Quickly" means within 30 s, or a quarter of the timeout if that is shorter
const FAST_FAILURE_MS = Math.min(30000, Math.floor(REQUEST_TIMEOUT_MS / 4));

// NVIDIA sent a success status, then the body broke off (connection reset, or
// silence until our timeout). axios reports it as an error that still carries
// the 2xx response, which must not be mistaken for an NVIDIA error status.
const cutOffAfterHeaders = err => Boolean(err.response) && err.response.status < 400;

// Calls exactly one model and never switches to a different one. Stops early
// when `signal` fires (the client hung up). Rejected errors carry
// `nimMessage`, NVIDIA's own explanation.
async function callModel(baseRequest, model, signal) {
  let rateLimitRetries = 0;
  let hiccupRetries = 0;
  const requestBytes = Buffer.byteLength(JSON.stringify({ ...baseRequest, model }));
  const messageCount = Array.isArray(baseRequest.messages) ? baseRequest.messages.length : 0;

  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      return await axios.post(
        `${NIM_API_BASE}/chat/completions`,
        { ...baseRequest, model },
        {
          headers: {
            Authorization: `Bearer ${NIM_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: baseRequest.stream ? 'stream' : 'json',
          timeout: REQUEST_TIMEOUT_MS,
          signal
        }
      );

    } catch (err) {
      if (signal?.aborted) throw err;

      const status = err.response?.status;
      const elapsed = Date.now() - started;
      err.nimModel = model;
      err.nimMessage = await describeUpstreamError(err);
      console.warn(
        `[PROXY] ${model} failed (attempt ${attempt}) after ${(elapsed / 1000).toFixed(1)}s:`,
        status || err.code || '',
        err.nimMessage,
        failureFacts(err, requestBytes, messageCount)
      );

      let delay = null;
      if (RATE_LIMIT_STATUSES.includes(status) && rateLimitRetries < RATE_LIMIT_RETRIES) {
        rateLimitRetries++;
        delay = RATE_LIMIT_DELAY_MS;
      } else if (
        (HICCUP_STATUSES.includes(status) || (!err.response && HICCUP_CODES.includes(err.code)) || cutOffAfterHeaders(err)) &&
        elapsed < FAST_FAILURE_MS &&
        hiccupRetries < HICCUP_RETRIES
      ) {
        hiccupRetries++;
        delay = HICCUP_DELAY_MS;
      }

      if (delay === null) throw err;
      await sleep(delay, signal);
      if (signal?.aborted) throw err;
    }
  }
}

// What NVIDIA's bare status codes usually mean, for errors that come without
// a useful message of their own
const STATUS_HINTS = {
  401: 'NIM_API_KEY is wrong or expired — make a new key at build.nvidia.com.',
  404: "NVIDIA had nothing to serve this model with right now. That is usually a short outage on NVIDIA's side (their own playground shows the same error): try again in a minute, or switch models for a while.",
  500: "NVIDIA's server failed while writing the reply. This is usually temporary: try again, or pick another model.",
  502: 'NVIDIA could not reach the model. Usually temporary: try again.',
  503: 'NVIDIA has no capacity for this model right now. Try again later or pick another model.',
  504: 'NVIDIA gave up waiting for the model; it is overloaded. Try again later or pick another model.'
};

// What the client is told when the upstream call fails
function upstreamFailure(err) {
  if (err.code === 'ECONNABORTED' && !err.response && /timeout/i.test(err.message)) {
    return {
      status: 504,
      message: `NVIDIA did not start answering within ${REQUEST_TIMEOUT_MS / 1000}s — it is probably overloaded. Try again, or pick another model.`
    };
  }
  if (cutOffAfterHeaders(err)) {
    return { status: 502, message: `NVIDIA's reply was cut off before it finished: ${err.message}. Try again.` };
  }
  if (err.response) {
    const status = err.response.status;
    // axios's own "Request failed with status code N" adds nothing to the status
    const detail = err.nimMessage && !/^Request failed with status code \d+$/.test(err.nimMessage) ? err.nimMessage : '';
    let hint = STATUS_HINTS[status] || '';
    if (status === 404 && /not found for account/i.test(detail)) {
      hint = 'Your NVIDIA account is not allowed to use this model: newer models can need the "Public API Endpoints" permission on your build.nvidia.com account.';
    }
    const text = [detail, hint].filter(Boolean).join(' — ') || err.message;
    return { status, message: `NVIDIA NIM error ${status} (${err.nimModel}): ${text}` };
  }
  return { status: 502, message: `Could not reach NVIDIA NIM: ${err.nimMessage || err.message}` };
}

// ─── Routes ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', commit: DEPLOYED_COMMIT });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(id => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: 'nim-proxy'
    }))
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  let streamEndedCleanly = false;
  let upstreamStream = null;
  let keepAliveTimer = null;
  let lastWriteAt = Date.now();
  let isStream = false;

  // 'close' on the response before it finished means the client hung up.
  // (req's own 'close' fires as soon as the body is read, so it can't tell.)
  const clientGone = new AbortController();
  res.on('close', () => {
    clearInterval(keepAliveTimer);
    if (!res.writableFinished) clientGone.abort();
  });

  const startSse = () => {
    if (res.headersSent) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  };
  const startJson = () => {
    if (res.headersSent) return;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
  };
  // A plain JSON reply, whether or not keep-alive already sent the headers
  const finishJson = (status, payload) => {
    clearInterval(keepAliveTimer);
    if (!res.headersSent) return res.status(status).json(payload);
    if (!res.writableEnded) res.end(JSON.stringify(payload));
  };
  const writeToClient = data => {
    lastWriteAt = Date.now();
    return safeWrite(res, data);
  };

  try {
    const {
      model,
      messages,
      temperature,
      max_tokens,
      stream
    } = req.body || {};
    isStream = Boolean(stream);

    // No default model: an unknown alias is an error, never a silent swap
    const nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      const old = OLD_MODEL_NAMES[model];
      const available = `Available models: ${Object.keys(MODEL_MAPPING).join(', ')}`;
      let message = `Unknown model "${model}". ${available}`;
      if (old?.now) {
        message = `Model "${model}" has been renamed to "${old.now}" — change the model name in your client.`;
      } else if (old?.retired) {
        message = `Model "${model}" was removed because NVIDIA retired ${old.retired}. Try "${old.try}" instead. ${available}`;
      }
      return res.status(400).json({
        error: {
          message,
          type: 'invalid_request_error',
          code: 'model_not_found'
        }
      });
    }
    const modelOptions = MODEL_OPTIONS[nimModel] || {};

    const added = applyPromptAdditions(messages, PROMPT_ADDITIONS);
    if (added.lore.length > 0) console.log(`[LORE] Added ${added.lore.length}: ${added.lore.join(', ')}`);
    if (added.dropped.length > 0) console.log(`[LORE] Over the token budget, left out: ${added.dropped.join(', ')}`);

    const baseRequest = {
      messages: added.messages,
      temperature: temperature ?? 0.7,
      max_tokens: Math.min((max_tokens ?? 2048) + (modelOptions.reasoningTokens || 0), MAX_TOKENS_LIMIT),
      stream: stream || false,
      chat_template_kwargs: modelOptions.chat_template_kwargs
    };

    if (KEEPALIVE_MS > 0) {
      keepAliveTimer = setInterval(() => {
        if (Date.now() - lastWriteAt < KEEPALIVE_MS) return;
        if (isStream) {
          startSse();
          writeToClient(': keep-alive\n\n');
        } else {
          startJson();
          writeToClient('\n');
        }
      }, Math.max(50, Math.floor(KEEPALIVE_MS / 2)));
    }

    const response = await callModel(baseRequest, nimModel, clientGone.signal);
    upstreamStream = response.data;
    console.log('[PROXY] Model used:', nimModel);

    if (stream) {
      startSse();

      const decoder = new StringDecoder('utf8');
      let buffer = '';
      let reasoningOpen = false;
      let doneSent = false;
      let cleanedUp = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(keepAliveTimer);
        if (upstreamStream) {
          upstreamStream.removeAllListeners();
          // An error after cleanup must not crash the process
          upstreamStream.on('error', () => {});
        }
      };

      const processLine = (line) => {
        if (!line.startsWith('data: ')) return;

        if (line.slice(6).trim() === '[DONE]') {
          if (!doneSent) {
            writeToClient('data: [DONE]\n\n');
            doneSent = true;
          }
          streamEndedCleanly = true;
          return;
        }

        try {
          const data = JSON.parse(line.slice(6));
          // NVIDIA can also fail inside a stream that already started with 200
          if (data.error && !data.choices) {
            console.warn(`[PROXY] ${nimModel} stream error:`, data.error.message || JSON.stringify(data.error).slice(0, 300));
          }
          const delta = data.choices?.[0]?.delta;

          if (delta) {
            let content = delta.content || '';
            // Some NIM backends name the field "reasoning" instead of "reasoning_content"
            const reasoning = delta.reasoning_content ?? delta.reasoning;

            if (SHOW_REASONING) {
              if (reasoning && !reasoningOpen) {
                content = `<thinking>\n${reasoning.replace(/\n/g, '\\n')}`;
                reasoningOpen = true;
              } else if (reasoning) {
                content = reasoning.replace(/\n/g, '\\n');
              }

              if (delta.content && reasoningOpen) {
                // Without reasoning in this chunk, content already holds delta.content
                content = `${reasoning ? content : ''}\n</thinking>\n\n${delta.content}`;
                reasoningOpen = false;
              }
            }

            delta.content = content;
            delete delta.reasoning_content;
            delete delta.reasoning;
          }

          writeToClient(`data: ${JSON.stringify(data)}\n\n`);

        } catch (parseErr) {
          // FIX: Don't silently swallow—send error to client so they know data was lost
          console.warn('[STREAM] Invalid JSON line:', line.slice(0, 100));
          writeToClient(`data: ${JSON.stringify({ 
            error: { 
              message: 'Upstream sent malformed chunk', 
              type: 'stream_parse_error',
              details: line.slice(0, 100)
            } 
          })}\n\n`);
        }
      };

      upstreamStream.on('data', chunk => {
        buffer += decoder.write(chunk);

        if (buffer.length > MAX_BUFFER_SIZE) {
          console.error('[STREAM] Buffer overflow, destroying connection');
          writeToClient(`data: ${JSON.stringify({ 
            error: { 
              message: 'Stream buffer overflow', 
              type: 'stream_error' 
            } 
          })}\n\n`);
          writeToClient('data: [DONE]\n\n');
          res.end();
          upstreamStream.destroy();
          cleanup();
          return;
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
        }
      });

      upstreamStream.on('end', () => {
        buffer += decoder.end();

        if (buffer.trim()) {
          for (const line of buffer.split('\n')) {
            processLine(line);
          }
        }

        if (!doneSent) {
          writeToClient('data: [DONE]\n\n');
        }

        streamEndedCleanly = true;
        if (!res.writableEnded) {
          res.end();
        }
        cleanup();
      });

      // Client hung up mid-reply: stop pulling the rest from NVIDIA
      let hangUpHandled = false;
      const onClientGone = () => {
        if (hangUpHandled) return;
        hangUpHandled = true;
        if (!streamEndedCleanly) {
          console.warn('[STREAM] Client disconnected before the reply finished');
          if (upstreamStream && !upstreamStream.destroyed) upstreamStream.destroy();
        }
        cleanup();
      };

      upstreamStream.on('error', err => {
        // Our own cancel after a client hang-up surfaces here too; it is not NVIDIA's fault
        if (clientGone.signal.aborted || axios.isCancel(err)) return onClientGone();
        console.error('[STREAM] Upstream error:', err.message);
        
        if (!res.writableEnded) {
          writeToClient(`data: ${JSON.stringify({
            error: {
              message: 'Stream interrupted by upstream error',
              type: 'stream_error'
            }
          })}\n\n`);
          writeToClient('data: [DONE]\n\n');
          res.end();
        }
        cleanup();
      });

      if (clientGone.signal.aborted) onClientGone();
      else clientGone.signal.addEventListener('abort', onClientGone, { once: true });

    } else {
      // Non-streaming response
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: (response.data.choices || []).map((choice, i) => {
          let content = choice.message?.content || '';
          const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning;

          if (SHOW_REASONING && reasoning) {
            const safeReasoning = reasoning.replace(/\n/g, '\\n');
            content = `<thinking>\n${safeReasoning}\n</thinking>\n\n${content}`;
          }

          return {
            index: i,
            message: {
              role: choice.message?.role || 'assistant',
              content,
              tool_calls: choice.message?.tool_calls
            },
            finish_reason: choice.finish_reason || 'stop'
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      finishJson(200, openaiResponse);
    }

  } catch (error) {
    clearInterval(keepAliveTimer);

    if (clientGone.signal.aborted) {
      console.warn('[PROXY] Client disconnected before NVIDIA answered; request cancelled');
      return;
    }

    const failure = upstreamFailure(error);
    console.error(`[PROXY] Request failed (${failure.status}): ${failure.message}`);

    const errorBody = {
      error: {
        message: failure.message,
        type: 'upstream_error',
        code: failure.status
      }
    };
    if (!isStream || !res.headersSent) {
      // Once keep-alive has sent a 200, the error can only go in the body
      finishJson(failure.status, errorBody);
    } else if (!res.writableEnded) {
      safeWrite(res, `data: ${JSON.stringify(errorBody)}\n\n`);
      safeWrite(res, 'data: [DONE]\n\n');
      res.end();
    }

    // Clean up upstream stream if we have it (a plain request's body is an object)
    if (typeof upstreamStream?.destroy === 'function' && !upstreamStream.destroyed) {
      upstreamStream.destroy();
    }
  }
});

// FIX: Express 5 named wildcard — but use proper 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.method} ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// Body-parser failures (bad JSON, too large) as JSON, never Express's HTML
// error page, which includes a stack trace with server paths. Express only
// treats a handler with all four arguments as an error handler.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: {
      message: err.type === 'entity.parse.failed' ? 'Request body is not valid JSON' : (status < 500 ? err.message : 'Internal error'),
      type: 'invalid_request_error',
      code: status
    }
  });
});

// ─── Startup ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[PROXY] Hybrid proxy running on port ${PORT} (commit ${DEPLOYED_COMMIT})`);
  console.log(`[PROXY] Max tokens limit: ${MAX_TOKENS_LIMIT}`);
  
  // Run validation after server starts, non-blocking
  validateModels().catch(err => {
    console.error('[VALIDATION] Startup check failed:', err.message);
  });
});
  
