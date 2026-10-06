// test/prompts.test.js — Unit tests for lorebook parsing/matching and how
// instructions and lore are added to a request (prompts.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseLorebook, applyPromptAdditions, loadPromptAdditions } = require('../prompts');

const config = (books, extra = {}) => ({
  books,
  scanDepth: 4,
  tokenBudget: 2048,
  instructions: null,
  instructionsPosition: 'bottom',
  ...extra
});
const book = (entries, extra = {}) => parseLorebook({ entries, ...extra }, 'test');
const lore = (entries, messages, extra) => applyPromptAdditions(messages, config([book(entries)], extra));
const user = content => ({ role: 'user', content });

describe('parsing lorebook formats', () => {
  it('reads a SillyTavern World Info export', () => {
    const parsed = parseLorebook({
      entries: {
        0: { uid: 0, key: ['Vel Arun'], keysecondary: [], comment: 'City', content: 'A harbor city.', order: 100, position: 1, disable: false },
        1: { uid: 1, key: ['old'], comment: 'Off', content: 'Disabled one.', disable: true },
        2: { uid: 2, key: [], comment: 'Always', content: 'Magic is rare.', constant: true, position: 0 }
      }
    }, 'fallback');
    assert.equal(parsed.name, 'fallback');
    assert.deepEqual(parsed.entries.map(e => [e.name, e.before, e.constant]), [['City', false, false], ['Always', true, true]]);
  });

  it('reads a V2 character_book, a whole V2 card, and comma-separated keys', () => {
    const v2 = { name: 'Book', scan_depth: 2, entries: [{ keys: 'Mira, ledger', content: 'Mira keeps a ledger.', enabled: true, insertion_order: 7 }] };
    const fromBook = parseLorebook(v2, 'x');
    const fromCard = parseLorebook({ spec: 'chara_card_v2', data: { name: 'Mira', character_book: v2 } }, 'x');
    for (const parsed of [fromBook, fromCard]) {
      assert.equal(parsed.name, 'Book');
      assert.equal(parsed.scanDepth, 2);
      assert.equal(parsed.entries.length, 1);
      assert.equal(parsed.entries[0].order, 7);
      assert.equal(parsed.entries[0].keys.length, 2);
    }
  });

  it('drops entries that are disabled, empty, or have no way to trigger', () => {
    const parsed = book([
      { keys: ['a'], content: 'kept' },
      { keys: ['b'], content: '   ' },
      { keys: ['c'], content: 'off', enabled: false },
      { keys: [], content: 'never triggers' }
    ]);
    assert.deepEqual(parsed.entries.map(e => e.name), ['a']);
  });

  it('rejects a file that is not a lorebook', () => {
    assert.throws(() => parseLorebook({ hello: 'world' }, 'x'), /no "entries" found/);
  });
});

describe('matching keywords', () => {
  it('is case-insensitive substring matching by default, like SillyTavern', () => {
    const r = lore([{ keys: ['dragon'], content: 'Dragons hoard gold.' }], [user('Two DRAGONS circle the tower.')]);
    assert.deepEqual(r.lore, ['dragon']);
  });

  it('honours whole-word matching, also around Polish letters', () => {
    const entries = [{ keys: ['kot'], content: 'Cats are sacred.', extensions: { match_whole_words: true } }];
    assert.deepEqual(lore(entries, [user('Zjadłem kotlet.')]).lore, []);
    assert.deepEqual(lore(entries, [user('Widzę kot, który śpi.')]).lore, ['kot']);
    const polish = [{ keys: ['Łódź'], content: 'A city.', extensions: { match_whole_words: true } }];
    assert.deepEqual(lore(polish, [user('Jedziemy do łódź jutro.')]).lore, ['Łódź']);
    assert.deepEqual(lore(polish, [user('Jedziemy do Łódźki.')]).lore, []);
    assert.deepEqual(lore(entries, [user('Pięć kotów.')]).lore, [], 'ó is a letter, so kot is not a whole word here');
  });

  it('treats combining accents as part of a word, and compares text in NFC form', () => {
    const pan = [{ keys: ['pan'], content: 'x', extensions: { match_whole_words: true } }];
    assert.deepEqual(lore(pan, [user('Dobre pan\u0301stwo')]).lore, [], 'decomposed "państwo"');
    assert.deepEqual(lore(pan, [user('Dzień dobry, pan Jan')]).lore, ['pan']);
    const ram = [{ keys: ['राम'], content: 'x', extensions: { match_whole_words: true } }];
    assert.deepEqual(lore(ram, [user('रामायण')]).lore, [], 'a vowel sign continues the word');
    const lodz = [{ keys: ['Łódź'], content: 'x' }];
    assert.deepEqual(lore(lodz, [user('Jedziemy do \u0141o\u0301dz\u0301')]).lore, ['Łódź'], 'decomposed text still matches');
  });

  it('honours case-sensitive entries', () => {
    const entries = [{ keys: ['Rose'], content: 'Rose is a knight.', case_sensitive: true }];
    assert.deepEqual(lore(entries, [user('a rose in bloom')]).lore, []);
    assert.deepEqual(lore(entries, [user('Rose draws her sword')]).lore, ['Rose']);
  });

  it('supports /regex/ keys', () => {
    const entries = [{ keys: ['/\\bbell(s)?\\b/i'], content: 'Bells ring.' }];
    assert.equal(lore(entries, [user('The BELLS!')]).lore.length, 1);
    assert.equal(lore(entries, [user('a bellow')]).lore.length, 0);
  });

  it('applies all four secondary-key rules', () => {
    const msg = [user('the harbor at night, rain falling')];
    const entry = logic => ({ keys: ['harbor'], secondary_keys: ['night', 'storm'], selective: true, content: 'x', extensions: { selectiveLogic: logic } });
    assert.equal(lore([entry(0)], msg).lore.length, 1, 'AND ANY: night is there');
    assert.equal(lore([entry(3)], msg).lore.length, 0, 'AND ALL: storm is missing');
    assert.equal(lore([entry(2)], msg).lore.length, 0, 'NOT ANY: night is there');
    assert.equal(lore([entry(1)], msg).lore.length, 1, 'NOT ALL: storm is missing');
  });

  it('only scans the last few chat messages', () => {
    const messages = [user('the harbor'), user('a'), user('b'), user('c'), user('d')];
    const entries = [{ keys: ['harbor'], content: 'x' }];
    assert.equal(lore(entries, messages).lore.length, 0, 'harbor is 5 messages back, default depth is 4');
    assert.equal(applyPromptAdditions(messages, config([book(entries, { scan_depth: 5 })])).lore.length, 1);
  });

  it('does not scan the system prompt (character definition)', () => {
    const r = lore([{ keys: ['harbor'], content: 'x' }], [{ role: 'system', content: 'Mira lives by the harbor.' }, user('hi')]);
    assert.equal(r.lore.length, 0);
  });
});

describe('adding lore and instructions to a request', () => {
  it('puts lore around the system prompt in order, without touching the input', () => {
    const messages = [{ role: 'system', content: 'You are Mira.' }, user('harbor and bells')];
    const frozen = JSON.parse(JSON.stringify(messages));
    const r = lore([
      { keys: ['bells'], content: 'B', insertion_order: 20 },
      { keys: ['harbor'], content: 'H', insertion_order: 10 },
      { keys: [], constant: true, content: 'TOP', position: 'before_char' }
    ], messages);
    assert.equal(r.messages[0].content, 'TOP\n\nYou are Mira.\n\nH\n\nB');
    assert.deepEqual(messages, frozen);
  });

  it('creates a system message when the chat has none', () => {
    const r = lore([{ keys: ['harbor'], content: 'H' }], [user('harbor')]);
    assert.deepEqual(r.messages[0], { role: 'system', content: 'H' });
  });

  it('keeps the highest-order entries when over the token budget', () => {
    const big = 'x'.repeat(3000);
    const r = lore([
      { keys: ['a'], content: big, insertion_order: 1, name: 'low' },
      { keys: ['a'], content: big, insertion_order: 9, name: 'high' },
      { keys: ['a'], content: big, insertion_order: 5, name: 'mid' }
    ], [user('a')], { tokenBudget: 2000 });
    assert.deepEqual(r.lore, ['mid', 'high']);
    assert.deepEqual(r.dropped, ['low']);
  });

  it('only uses a book with "characters" in chats with that character', () => {
    const scoped = parseLorebook({ characters: ['Mira'], entries: [{ keys: [], constant: true, content: 'Mira lore' }] }, 'x');
    const forMira = applyPromptAdditions([{ role: 'system', content: "Mira's persona" }, user('hi')], config([scoped]));
    const forOther = applyPromptAdditions([{ role: 'system', content: "Kael's persona (Miranda is his sister)" }, user('hi')], config([scoped]));
    assert.deepEqual(forMira.lore, ['entry 1']);
    assert.deepEqual(forOther.lore, []);
  });

  it('adds instructions after the chat by default, or into the system prompt with "top"', () => {
    const messages = [{ role: 'system', content: 'You are Mira.' }, user('hi')];
    const bottom = applyPromptAdditions(messages, config([], { instructions: 'RULES' }));
    assert.deepEqual(bottom.messages.at(-1), { role: 'system', content: 'RULES' });
    const top = applyPromptAdditions(messages, config([], { instructions: 'RULES', instructionsPosition: 'top' }));
    assert.equal(top.messages.length, 2);
    assert.equal(top.messages[0].content, 'You are Mira.\n\nRULES');
  });

  it('appends to array (multimodal) content as an extra text part', () => {
    const messages = [{ role: 'system', content: [{ type: 'text', text: 'You are Mira.' }] }, user('harbor')];
    const r = lore([{ keys: ['harbor'], content: 'H' }], messages);
    assert.deepEqual(r.messages[0].content, [{ type: 'text', text: 'You are Mira.' }, { type: 'text', text: 'H' }]);
  });

  it('returns the very same messages when there is nothing to add', () => {
    const messages = [user('hi')];
    assert.equal(applyPromptAdditions(messages, config([])).messages, messages);
  });
});

describe('loading files', () => {
  it('finds instructions and lorebooks in the Render secrets folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
    try {
      fs.writeFileSync(path.join(dir, 'instructions.txt'), '  Be vivid.  \n');
      fs.writeFileSync(path.join(dir, 'lorebook-world.json'), JSON.stringify({ entries: [{ keys: ['a'], content: 'A' }] }));
      fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ entries: [{ keys: ['b'], content: 'B' }] }));
      const logs = [];
      const log = { log: m => logs.push(m), warn: m => logs.push(m) };
      const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
      const loaded = loadPromptAdditions({ env: {}, log, secretsDir: dir, repoDir: emptyRepo });
      fs.rmSync(emptyRepo, { recursive: true, force: true });
      assert.equal(loaded.instructions, 'Be vivid.');
      assert.equal(loaded.instructionsPosition, 'bottom');
      assert.deepEqual(loaded.books.map(b => b.name), ['lorebook-world'], 'only lorebook*.json files count');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips an instructions file it cannot read instead of crashing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
    const unreadable = path.join(dir, 'instructions.md');
    fs.writeFileSync(unreadable, 'secret');
    fs.writeFileSync(path.join(dir, 'instructions.txt'), 'Fallback rules.');
    const realRead = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      if (file === unreadable) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realRead(file, ...rest);
    };
    try {
      const warnings = [];
      const loaded = loadPromptAdditions({ env: {}, log: { log() {}, warn: m => warnings.push(m) }, secretsDir: dir, repoDir: dir });
      assert.equal(loaded.instructions, 'Fallback rules.');
      assert.match(warnings.join('\n'), /Skipped .*instructions\.md: EACCES/);
    } finally {
      fs.readFileSync = realRead;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns about INSTRUCTIONS_PATH and LOREBOOK_PATH entries that do not exist', () => {
    const warnings = [];
    loadPromptAdditions({
      env: { INSTRUCTIONS_PATH: '/nope/rules.md', LOREBOOK_PATH: '/nope/books', PROMPT_FILES_DEFAULT_LOCATIONS: 'off' },
      log: { log() {}, warn: m => warnings.push(m) }
    });
    assert.equal(warnings.length, 2, warnings.join('\n'));
  });

  it('reads the scan depth, budget and position from the environment', () => {
    const loaded = loadPromptAdditions({
      env: { LOREBOOK_SCAN_DEPTH: '9', LOREBOOK_TOKEN_BUDGET: '100', INSTRUCTIONS_POSITION: 'top', PROMPT_FILES_DEFAULT_LOCATIONS: 'off' },
      log: { log() {}, warn() {} }
    });
    assert.deepEqual([loaded.scanDepth, loaded.tokenBudget, loaded.instructionsPosition], [9, 100, 'top']);
  });
});
