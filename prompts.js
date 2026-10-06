// prompts.js — Text the proxy adds to every chat: fixed instructions for the
// bot, and lorebook entries whose keywords show up in the recent messages.
//
// Both are read once at startup from files, so private lore never has to sit
// in this (public) repo. Each source is used if it exists:
//
//   Instructions (first match wins)
//     $INSTRUCTIONS_PATH
//     /etc/secrets/instructions.md or .txt      (Render "Secret Files")
//     prompts/instructions.md or .txt           (in the repo, public!)
//
//   Lorebooks (all of them are loaded)
//     $LOREBOOK_PATH (comma-separated files or folders)
//     /etc/secrets/lorebook*.json               (Render "Secret Files")
//     lorebooks/*.json                          (in the repo, public!)
//
// Lorebooks can be SillyTavern World Info exports, Character Card V2
// "character_book"s (Chub and most card editors), a whole V2 card, or the
// same shape written by hand: { "entries": [ { "keys": [...], "content": "..." } ] }.

const fs = require('fs');
const path = require('path');

const SECRETS_DIR = '/etc/secrets';
const REPO_DIR = __dirname;

const DEFAULT_SCAN_DEPTH = 4;
const DEFAULT_TOKEN_BUDGET = 2048;
// Rough English average; only used to keep the lorebook inside its budget
const CHARS_PER_TOKEN = 4;

// ─── Loading ───────────────────────────────────────────────────────────────

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDir(dir, pattern) {
  try {
    return fs.readdirSync(dir)
      .filter(name => pattern.test(name))
      .sort()
      .map(name => path.join(dir, name))
      .filter(isFile);
  } catch {
    return [];
  }
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return n > 0 ? n : fallback;
}

function findInstructions(env, secretsDir, useDefaults) {
  const candidates = [
    env.INSTRUCTIONS_PATH,
    ...(useDefaults ? [
      path.join(secretsDir, 'instructions.md'),
      path.join(secretsDir, 'instructions.txt'),
      path.join(REPO_DIR, 'prompts', 'instructions.md'),
      path.join(REPO_DIR, 'prompts', 'instructions.txt')
    ] : [])
  ].filter(Boolean);

  for (const file of candidates) {
    if (!isFile(file)) continue;
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text) return { text, source: file };
  }
  return null;
}

function findLorebookFiles(env, secretsDir, useDefaults) {
  const files = [];
  for (const entry of (env.LOREBOOK_PATH || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (isFile(entry)) files.push(entry);
    else files.push(...listDir(entry, /\.json$/i));
  }
  if (useDefaults) {
    files.push(...listDir(secretsDir, /^lorebook.*\.json$/i));
    files.push(...listDir(path.join(REPO_DIR, 'lorebooks'), /\.json$/i));
  }
  return [...new Set(files.map(f => path.resolve(f)))];
}

// ─── Lorebook parsing ──────────────────────────────────────────────────────

const toList = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
  .map(k => String(k).trim())
  .filter(Boolean);

// SillyTavern's selectiveLogic numbers, and the names V2 cards use for them
const LOGIC = { 0: 'and_any', 1: 'not_all', 2: 'not_any', 3: 'and_all' };

function normalizeEntry(raw, index) {
  const ext = raw.extensions || {};

  // ST: disable / position number; V2: enabled / position string
  const enabled = raw.disable === true ? false : raw.enabled !== false;
  const position = raw.position ?? ext.position;
  const before = position === 'before_char' || position === 0;

  const secondaryKeys = toList(raw.keysecondary ?? raw.secondary_keys);
  const logicValue = raw.selectiveLogic ?? ext.selectiveLogic;
  const selective = raw.selective === true || (raw.selective === undefined && secondaryKeys.length > 0);

  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  const keys = toList(raw.key ?? raw.keys);

  // Like SillyTavern: case-insensitive substring matching unless the entry
  // asks otherwise, so "dragon" also fires on "dragons"
  const matchOptions = {
    caseSensitive: (raw.caseSensitive ?? raw.case_sensitive ?? ext.case_sensitive) === true,
    wholeWords: (raw.matchWholeWords ?? ext.match_whole_words) === true
  };
  const order = Number(raw.order ?? raw.insertion_order);

  return {
    name: String(raw.comment || raw.name || keys[0] || `entry ${index + 1}`),
    keys: keys.map(k => keyMatcher(k, matchOptions)),
    secondaryKeys: (selective ? secondaryKeys : []).map(k => keyMatcher(k, matchOptions)),
    logic: LOGIC[logicValue] || (Object.values(LOGIC).includes(logicValue) ? logicValue : 'and_any'),
    content,
    constant: raw.constant === true,
    enabled: enabled && content.length > 0,
    order: Number.isFinite(order) ? order : 100,
    before
  };
}

function parseLorebook(json, fallbackName) {
  // A whole V2 character card: take its embedded book
  const book = json?.data?.character_book || json?.character_book || json;
  if (!book || typeof book !== 'object' || !book.entries || typeof book.entries !== 'object') {
    throw new Error('no "entries" found (expected a SillyTavern World Info export or a V2 character_book)');
  }

  // ST keys entries by uid in an object; V2 uses an array
  const rawEntries = Array.isArray(book.entries) ? book.entries : Object.values(book.entries);
  const entries = rawEntries
    .filter(e => e && typeof e === 'object')
    .map(normalizeEntry)
    .filter(e => e.enabled && (e.constant || e.keys.length > 0));

  // Optional, our own field: only use this book in chats whose character
  // definition mentions one of these names
  const characters = toList(book.characters);

  return {
    name: String(book.name || json?.data?.name || fallbackName),
    scanDepth: positiveInt(book.scan_depth ?? book.scanDepth, null),
    characters,
    characterMatchers: characters.map(name => keyMatcher(name, { caseSensitive: false, wholeWords: true })),
    entries
  };
}

// ─── Matching ──────────────────────────────────────────────────────────────

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// /pattern/flags keys are regular expressions. With wholeWords, "kot" must
// not match "kotlet" even around Polish letters, so word edges are any letter
// or digit in any script rather than ASCII-only \b
function keyMatcher(key, { caseSensitive, wholeWords }) {
  const asRegex = key.match(/^\/(.+)\/([a-z]*)$/s);
  if (asRegex) {
    try {
      const re = new RegExp(asRegex[1], asRegex[2].replace(/[gy]/g, ''));
      return text => re.test(text);
    } catch {
      // Not a valid regex after all: treat it as plain text
    }
  }
  const body = escapeRegExp(key);
  const edged = wholeWords ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  const re = new RegExp(edged, caseSensitive ? 'u' : 'iu');
  return text => re.test(text);
}

function entryMatches(entry, text) {
  if (entry.constant) return true;
  const hit = matches => matches(text);
  if (!entry.keys.some(hit)) return false;
  if (entry.secondaryKeys.length === 0) return true;

  const hits = entry.secondaryKeys.filter(hit).length;
  switch (entry.logic) {
    case 'and_all': return hits === entry.secondaryKeys.length;
    case 'not_any': return hits === 0;
    case 'not_all': return hits < entry.secondaryKeys.length;
    default: return hits > 0;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p?.type === 'text' ? p.text || '' : '')).join('\n');
  }
  return '';
}

// ─── Applying to a request ─────────────────────────────────────────────────

function appendText(content, text, atStart) {
  if (Array.isArray(content)) {
    const part = { type: 'text', text };
    return atStart ? [part, ...content] : [...content, part];
  }
  const existing = typeof content === 'string' ? content : '';
  if (!existing) return text;
  return atStart ? `${text}\n\n${existing}` : `${existing}\n\n${text}`;
}

/**
 * Returns a copy of `messages` with lorebook entries and instructions added,
 * plus the names of the entries used (for logging). Never mutates the input.
 */
function applyPromptAdditions(messages, config) {
  const result = { messages, lore: [], dropped: [], instructions: false };
  if (!Array.isArray(messages) || messages.length === 0) return result;
  if (!config.instructions && config.books.length === 0) return result;

  let out = messages.slice();
  const systemIndex = out[0]?.role === 'system' ? 0 : -1;
  const systemText = systemIndex === 0 ? textOf(out[0].content) : '';

  // ── Lorebook ──
  const chat = out.filter(m => m && m.role !== 'system');
  const picked = [];
  for (const book of config.books) {
    if (book.characterMatchers.length > 0 && !book.characterMatchers.some(m => m(systemText))) continue;
    const depth = book.scanDepth || config.scanDepth;
    const scanText = chat.slice(-depth).map(m => textOf(m.content)).join('\n');
    for (const entry of book.entries) {
      if (entryMatches(entry, scanText)) picked.push(entry);
    }
  }

  if (picked.length > 0) {
    // Highest order wins the budget; the survivors are then written lowest first
    const budgetChars = config.tokenBudget * CHARS_PER_TOKEN;
    let used = 0;
    const kept = [];
    for (const entry of [...picked].sort((a, b) => b.order - a.order)) {
      if (used + entry.content.length > budgetChars) {
        result.dropped.push(entry.name);
        continue;
      }
      used += entry.content.length;
      kept.push(entry);
    }
    kept.sort((a, b) => a.order - b.order);

    const before = kept.filter(e => e.before).map(e => e.content).join('\n\n');
    const after = kept.filter(e => !e.before).map(e => e.content).join('\n\n');

    if (systemIndex === 0) {
      let content = out[0].content;
      if (before) content = appendText(content, before, true);
      if (after) content = appendText(content, after, false);
      out[0] = { ...out[0], content };
    } else {
      out = [{ role: 'system', content: [before, after].filter(Boolean).join('\n\n') }, ...out];
    }
    result.lore = kept.map(e => e.name);
  }

  // ── Instructions ──
  if (config.instructions) {
    if (config.instructionsPosition === 'top') {
      if (out[0]?.role === 'system') {
        out[0] = { ...out[0], content: appendText(out[0].content, config.instructions, false) };
      } else {
        out = [{ role: 'system', content: config.instructions }, ...out];
      }
    } else {
      // After the whole chat, where models follow it most closely
      out = [...out, { role: 'system', content: config.instructions }];
    }
    result.instructions = true;
  }

  result.messages = out;
  return result;
}

/**
 * Reads instructions and lorebooks from disk. Problems are logged and skipped,
 * never fatal: a broken lorebook must not take the proxy down.
 */
function loadPromptAdditions({ env = process.env, log = console, secretsDir = SECRETS_DIR } = {}) {
  const config = {
    instructions: null,
    instructionsPosition: env.INSTRUCTIONS_POSITION === 'top' ? 'top' : 'bottom',
    books: [],
    scanDepth: positiveInt(env.LOREBOOK_SCAN_DEPTH, DEFAULT_SCAN_DEPTH),
    tokenBudget: positiveInt(env.LOREBOOK_TOKEN_BUDGET, DEFAULT_TOKEN_BUDGET)
  };

  // The tests turn the default locations off so files on the machine can't leak in
  const useDefaults = env.PROMPT_FILES_DEFAULT_LOCATIONS !== 'off';

  const found = findInstructions(env, secretsDir, useDefaults);
  if (found) {
    config.instructions = found.text;
    log.log(`[PROMPTS] Instructions: ${found.text.length} chars from ${found.source} (added at the ${config.instructionsPosition})`);
  }

  for (const file of findLorebookFiles(env, secretsDir, useDefaults)) {
    try {
      const book = parseLorebook(JSON.parse(fs.readFileSync(file, 'utf8')), path.basename(file, '.json'));
      config.books.push(book);
      const scope = book.characters.length ? ` for ${book.characters.join(', ')}` : '';
      log.log(`[LORE] Loaded "${book.name}" (${book.entries.length} entries${scope}) from ${file}`);
    } catch (err) {
      log.warn(`[LORE] Skipped ${file}: ${err.message}`);
    }
  }
  if (config.books.length > 0) {
    log.log(`[LORE] Scanning the last ${config.scanDepth} messages, up to ~${config.tokenBudget} tokens of lore per request`);
  }

  return config;
}

module.exports = { loadPromptAdditions, applyPromptAdditions, parseLorebook };
