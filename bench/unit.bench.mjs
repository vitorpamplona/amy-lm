// unit.bench.mjs — covers the pure/translation logic the refactor touched:
// the NIP-19 codec (now its own module), the auth.js key-verification helper
// (now one shared listModels), and the llm.js tool loop (now one shared
// runToolLoop driving all three providers). These paths had no tests; they do
// now, so the dedup can't silently change behavior. fetch is mocked.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

let failed = 0;
const check = (d, fn) => { try { fn(); console.log(`  ✓ ${d}`); } catch (e) { failed++; console.log(`  ✗ ${d}\n      ${e.message}`); } };
const acheck = async (d, fn) => { try { await fn(); console.log(`  ✓ ${d}`); } catch (e) { failed++; console.log(`  ✗ ${d}\n      ${e.message}`); } };

// A fetch stub: hand it a queue of [responseObj, {ok,status}] and it returns
// them in order; or a thrower to simulate a network failure.
const res = (body, { ok = true, status = 200 } = {}) => ({ ok, status, statusText: 'ERR', json: async () => body });
function mockFetch(queue) {
  let i = 0;
  globalThis.fetch = async () => { const r = queue[Math.min(i++, queue.length - 1)]; if (r instanceof Error) throw r; return r; };
}

// ===========================================================================
// NIP-19 codec
// ===========================================================================
console.log('\nNIP-19 codec');
{
  const { nip19 } = await imp('js/nip19.js');
  const nostr = await imp('js/nostr.js'); // re-export must be the same surface
  const hex = 'a'.repeat(63) + '3';
  check('npub round-trips hex -> npub -> hex', () => {
    const npub = nip19.npubEncode(hex);
    assert.ok(npub.startsWith('npub1'));
    const back = nip19.decode(npub);
    assert.equal(back.type, 'npub');
    assert.equal(back.data, hex);
  });
  check('note encodes with the note hrp', () => assert.ok(nip19.noteEncode(hex).startsWith('note1')));
  check('toHexPubkey accepts npub and passes hex through', () => {
    assert.equal(nip19.toHexPubkey(nip19.npubEncode(hex)), hex);
    assert.equal(nip19.toHexPubkey(hex), hex);
  });
  check('nostr.js re-exports the same nip19', () => assert.equal(nostr.nip19, nip19));
}

// ===========================================================================
// auth.js — verifyApiKey (shared listModels helper)
// ===========================================================================
console.log('\nauth.js verifyApiKey');
{
  const { verifyApiKey, detectProvider } = await imp('js/auth.js');
  check('detectProvider keys + base URL', () => {
    assert.equal(detectProvider('sk-ant-abc'), 'anthropic');
    assert.equal(detectProvider('sk-proj-abc'), 'openai');
    assert.equal(detectProvider('AIzaABC'), 'google');
    assert.equal(detectProvider('AQ.xyz'), 'google');
    assert.equal(detectProvider('whatever', 'http://localhost:11434/v1'), 'openai-compatible');
    assert.equal(detectProvider('nope'), null);
  });
  await acheck('anthropic success parses model ids', async () => {
    mockFetch([res({ data: [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku' }] })]);
    const { provider, models } = await verifyApiKey('sk-ant-xyz');
    assert.equal(provider, 'anthropic');
    assert.deepEqual(models, ['claude-opus-4-8', 'claude-haiku']);
  });
  await acheck('google filters to generateContent models and strips prefix', async () => {
    mockFetch([res({ models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
    ] })]);
    const { provider, models } = await verifyApiKey('AIzaXXX');
    assert.equal(provider, 'google');
    assert.deepEqual(models, ['gemini-2.5-pro']);
  });
  await acheck('a bad key throws the provider-named reject message', async () => {
    mockFetch([res({}, { ok: false, status: 401 })]);
    await assert.rejects(() => verifyApiKey('sk-openai'), /OpenAI rejected that key/);
  });
  await acheck('Gemini uses "Google" for reject but "Gemini" for HTTP errors', async () => {
    mockFetch([res({}, { ok: false, status: 403 })]);
    await assert.rejects(() => verifyApiKey('AIzaBAD'), /Google rejected that key/);
    mockFetch([res({ error: { message: 'boom' } }, { ok: false, status: 500 })]);
    await assert.rejects(() => verifyApiKey('AIzaBAD'), /Gemini API 500: boom/);
  });
  await acheck('a network failure throws a reachability message', async () => {
    mockFetch([new Error('offline')]);
    await assert.rejects(() => verifyApiKey('sk-ant-xyz'), /Could not reach the Anthropic API/);
  });
}

// ===========================================================================
// llm.js — converse() runs the unified tool loop for each provider shape
// ===========================================================================
console.log('\nllm.js converse tool loop');
{
  const { converse } = await imp('js/llm.js');
  const tools = [{ name: 'echo', description: 'echo', input_schema: { type: 'object', properties: { x: { type: 'number' } } } }];

  // Anthropic shape: round 1 asks for a tool, round 2 finishes with text.
  await acheck('anthropic: tool_use -> tool_result -> text, history intact', async () => {
    mockFetch([
      res({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { x: 1 } }] }),
      res({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }),
    ]);
    const messages = [{ role: 'user', content: 'hi' }];
    const seen = []; const texts = [];
    await converse({ apiKey: 'sk-ant-x', provider: 'anthropic', model: 'm', system: 's', messages, tools,
      dispatch: async (name, input) => { seen.push([name, input]); return `ran ${name}`; },
      onText: (t) => texts.push(t) });
    assert.deepEqual(seen, [['echo', { x: 1 }]]);
    assert.deepEqual(texts, ['done']);
    // user, assistant(tool_use), user(tool_result), assistant(text)
    assert.equal(messages.length, 4);
    assert.equal(messages[1].content[0].type, 'tool_use');
    assert.equal(messages[2].content[0].type, 'tool_result');
    assert.equal(messages[2].content[0].content, 'ran echo');
    assert.equal(messages[3].content[0].text, 'done');
  });

  // OpenAI shape: tool_calls then a content message; loop + translation.
  await acheck('openai: tool_calls translate to canonical blocks and run', async () => {
    mockFetch([
      res({ choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{"x":2}' } }] } }] }),
      res({ choices: [{ message: { content: 'ok' } }] }),
    ]);
    const messages = [{ role: 'user', content: 'hi' }];
    const seen = [];
    await converse({ apiKey: 'sk-openai', provider: 'openai', model: 'm', system: 's', messages, tools,
      dispatch: async (n, i) => { seen.push([n, i]); return 'x'; } });
    assert.deepEqual(seen, [['echo', { x: 2 }]]);
    assert.equal(messages[1].content[0].type, 'tool_use');
    assert.equal(messages[3].content[0].text, 'ok');
  });

  // Gemini shape: functionCall part then a text part.
  await acheck('gemini: functionCall translates and runs', async () => {
    mockFetch([
      res({ candidates: [{ content: { parts: [{ functionCall: { name: 'echo', args: { x: 3 } } }] } }] }),
      res({ candidates: [{ content: { parts: [{ text: 'fin' }] } }] }),
    ]);
    const messages = [{ role: 'user', content: 'hi' }];
    const seen = [];
    await converse({ apiKey: 'AIzaX', provider: 'google', model: 'm', system: 's', messages, tools,
      dispatch: async (n, i) => { seen.push([n, i]); return 'y'; } });
    assert.deepEqual(seen, [['echo', { x: 3 }]]);
    assert.equal(messages[3].content[0].text, 'fin');
  });

  // A throwing tool becomes an is_error tool_result (loop keeps going).
  await acheck('a tool that throws is reported as is_error', async () => {
    mockFetch([
      res({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }] }),
      res({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'recovered' }] }),
    ]);
    const messages = [{ role: 'user', content: 'hi' }];
    await converse({ apiKey: 'sk-ant-x', provider: 'anthropic', model: 'm', system: 's', messages, tools,
      dispatch: async () => { throw new Error('kaboom'); } });
    const result = messages[2].content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /kaboom/);
  });

  // No tool_use -> the loop returns after one round.
  await acheck('a plain text answer ends the loop in one round', async () => {
    mockFetch([res({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] })]);
    const messages = [{ role: 'user', content: 'hi' }];
    const texts = [];
    await converse({ apiKey: 'sk-ant-x', provider: 'anthropic', model: 'm', system: 's', messages, tools, dispatch: async () => 'n/a', onText: (t) => texts.push(t) });
    assert.deepEqual(texts, ['hello']);
    assert.equal(messages.length, 2);
  });
}

console.log(failed ? `\n${failed} unit check(s) FAILED\n` : '\nAll unit checks passed.\n');
process.exit(failed ? 1 : 0);
