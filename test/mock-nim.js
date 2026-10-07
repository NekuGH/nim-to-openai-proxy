// test/mock-nim.js — Stand-in for integrate.api.nvidia.com used by the tests.
//
// It mimics how NIM serves the models the proxy tunes per-model options for,
// following each model's published chat template, so a wrong request shape
// fails loudly instead of silently "working" against a lenient fake:
//
// - z-ai/glm-5.3, z-ai/glm-5.3-flash: always think. reasoning_effort other
//   than low/high falls back to max. enable_thinking: false is ignored by the
//   template, so the thinking leaks into the reply (as on real NIM).
// - deepseek-ai/deepseek-v4.1-flash: without chat_template_kwargs NIM can hang
//   with no reply; here that is a fast 504. thinking and enable_thinking must
//   agree, and reasoning_effort must be one every serving stack accepts.
//
// GLM-5.3-Flash streams its thinking as "reasoning", the others as
// "reasoning_content", so both field names the proxy handles get exercised.
//
// startMockNim({ headerDelayMs, midStreamSilenceMs }) imitates an overloaded
// NIM: a long wait before it answers at all, or a stream that goes quiet
// after its first bytes. `failures` is a list of { status, body } answered,
// in order, to the first chat requests instead of a reply ({ cutOff: true }
// instead sends 200 and half a body, then drops the connection, and `raw`
// sends that exact body text, e.g. '' for an empty error); `answer` replaces
// the reply text and `chunkSize` sets how many characters each streamed piece
// of it carries.

const http = require('http');

const NIM_KEY = 'test-nim-key';

const CATALOG = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'deepseek-ai/deepseek-v4.1-flash',
  'z-ai/glm-5.3',
  'z-ai/glm-5.3-flash'
];

const GLM_MODELS = ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash'];
const DEEPSEEK_V41 = 'deepseek-ai/deepseek-v4.1-flash';
const SAFE_DEEPSEEK_EFFORTS = ['low', 'high', 'max'];

// Polish diacritics are multi-byte in UTF-8; the stream writer splits one of
// them across two writes to check the proxy reassembles it correctly.
function answerFor(model, override) {
  return override ?? `Cześć! Zażółć gęślą jaźń — reply from ${model}.`;
}

function reasoningFor(model, effort) {
  return `REASONING[${model}|effort=${effort}]\nstep 1\nstep 2`;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Works out what the model would produce for this request, or throws the
// error NIM would answer with.
function plan(body) {
  const model = body.model;
  const kwargs = body.chat_template_kwargs;

  if (!CATALOG.includes(model)) {
    throw new HttpError(404, `Function for model '${model}' Not found`);
  }

  if (GLM_MODELS.includes(model)) {
    const effort = ['low', 'high'].includes(kwargs?.reasoning_effort)
      ? kwargs.reasoning_effort
      : 'max';
    return {
      thinking: true,
      // No reasoning parser split happens when the request fights the template
      leakReasoning: kwargs?.enable_thinking === false,
      effort,
      reasoningField: model === 'z-ai/glm-5.3-flash' ? 'reasoning' : 'reasoning_content'
    };
  }

  if (model === DEEPSEEK_V41) {
    if (!kwargs) {
      throw new HttpError(504, 'Simulated NIM hang: DeepSeek V4 request without chat_template_kwargs');
    }
    const flags = [kwargs.thinking, kwargs.enable_thinking].filter(v => v !== undefined);
    if (flags.length === 0) {
      throw new HttpError(504, 'Simulated NIM hang: no thinking switch in chat_template_kwargs');
    }
    if (flags.some(v => typeof v !== 'boolean') || new Set(flags).size > 1) {
      throw new HttpError(400, 'thinking and enable_thinking must be matching booleans');
    }
    const thinking = flags[0];
    if (kwargs.reasoning_effort !== undefined && !SAFE_DEEPSEEK_EFFORTS.includes(kwargs.reasoning_effort)) {
      throw new HttpError(400, `Invalid reasoning effort: ${kwargs.reasoning_effort}`);
    }
    return {
      thinking,
      leakReasoning: false,
      effort: thinking ? (kwargs.reasoning_effort || 'high') : null,
      reasoningField: 'reasoning_content'
    };
  }

  // Other catalog models: plain replies, no thinking
  return { thinking: false, leakReasoning: false, effort: null, reasoningField: 'reasoning_content' };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function completion(body, p, answerOverride) {
  const answer = answerFor(body.model, answerOverride);
  const reasoning = p.thinking ? reasoningFor(body.model, p.effort) : null;
  const message = { role: 'assistant', content: answer };

  if (p.leakReasoning) {
    message.content = `${reasoning}</think>${answer}`;
  } else if (reasoning) {
    message[p.reasoningField] = reasoning;
  }

  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1,
    model: body.model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }
  };
}

function chunk(model, delta, finishReason = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Writes SSE frames over several TCP writes, deliberately splitting a frame
// mid-line and a multi-byte character mid-sequence.
async function streamCompletion(res, body, p, { silenceMs, answerOverride, chunkSize = 5 }) {
  const answer = answerFor(body.model, answerOverride);
  const frames = [chunk(body.model, { role: 'assistant', content: '' })];

  if (p.thinking) {
    const reasoning = reasoningFor(body.model, p.effort);
    for (const piece of reasoning.match(/[\s\S]{1,7}/g)) {
      frames.push(chunk(body.model, p.leakReasoning
        ? { content: piece }
        : { content: null, [p.reasoningField]: piece }));
    }
    if (p.leakReasoning) frames.push(chunk(body.model, { content: '</think>' }));
  }

  for (const piece of answer.match(new RegExp(`[\\s\\S]{1,${chunkSize}}`, 'g'))) {
    frames.push(chunk(body.model, { content: piece }));
  }
  frames.push(chunk(body.model, {}, 'stop'));

  const wire = Buffer.from(
    frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n',
    'utf8'
  );

  // Cut points: inside the first multi-byte character, and at odd offsets
  const multiByteAt = wire.indexOf(Buffer.from('ś', 'utf8'));
  const cuts = [...new Set([multiByteAt + 1, 37, 101, Math.floor(wire.length / 2) + 3])]
    .filter(c => c > 0 && c < wire.length)
    .sort((a, b) => a - b);

  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let start = 0;
  for (const cut of [...cuts, wire.length]) {
    if (res.destroyed) return;
    res.write(wire.subarray(start, cut));
    if (start === 0 && silenceMs) await sleep(silenceMs);
    start = cut;
    await new Promise(r => setImmediate(r));
  }
  res.end();
}

function startMockNim({ headerDelayMs = 0, midStreamSilenceMs = 0, failures = [], answer, chunkSize } = {}) {
  const requests = [];
  const pendingFailures = [...failures];
  let disconnects = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', d => { raw += d; });
    req.on('end', async () => {
      if (req.headers.authorization !== `Bearer ${NIM_KEY}`) {
        return sendJson(res, 401, { status: 401, title: 'Unauthorized' });
      }

      if (req.method === 'GET' && req.url === '/v1/models') {
        return sendJson(res, 200, {
          object: 'list',
          data: CATALOG.map(id => ({ id, object: 'model', owned_by: id.split('/')[0] }))
        });
      }

      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: { message: 'Invalid JSON' } });
        }
        requests.push(body);

        let p;
        try {
          p = plan(body);
        } catch (err) {
          return sendJson(res, err.status || 500, { error: { message: err.message } });
        }

        res.on('close', () => { if (!res.writableFinished) disconnects++; });
        if (headerDelayMs) await sleep(headerDelayMs);
        if (res.destroyed) return;

        const failure = pendingFailures.shift();
        if (failure?.cutOff) {
          res.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
          res.write(body.stream ? 'data: {"choices":[{"delta":{"content":"Hal' : '{"id":"x","choices":[{"message":{"content":"Hal');
          return setTimeout(() => res.destroy(), 50);
        }
        if (failure?.raw !== undefined) {
          res.writeHead(failure.status, { 'Content-Type': 'application/json' });
          return res.end(failure.raw);
        }
        if (failure) return sendJson(res, failure.status, failure.body ?? { error: { message: `mock failure ${failure.status}` } });

        if (body.stream) return streamCompletion(res, body, p, { silenceMs: midStreamSilenceMs, answerOverride: answer, chunkSize });
        return sendJson(res, 200, completion(body, p, answer));
      }

      sendJson(res, 404, { error: { message: `No route ${req.method} ${req.url}` } });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        lastRequest: () => requests[requests.length - 1],
        disconnects: () => disconnects,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

module.exports = { startMockNim, answerFor, reasoningFor, NIM_KEY, CATALOG };
