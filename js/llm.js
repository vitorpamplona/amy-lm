// llm.js — talks to the chosen LLM (Anthropic Claude, OpenAI, Google Gemini, or
// any OpenAI-compatible endpoint) directly from the browser and runs the
// tool-use loop that lets the model build the client.
//
// No server: requests go straight to the provider's API using the user's own
// key (stored locally). All built-in providers allow direct browser access via
// CORS — Anthropic needs the direct-browser-access opt-in header; OpenAI and
// Gemini do not. An OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter,
// Groq, Together, …) reuses the OpenAI request/translation path against a
// user-supplied base URL; whether it works from the browser depends on that
// server's CORS policy (local servers generally allow it).
//
// The conversation is stored in one canonical (Anthropic-shaped) message format
// in app/storage; the OpenAI and Gemini paths translate that to/from their
// respective shapes on the way in and out, so the rest of the app never has to
// branch.

import { detectProvider, normalizeBaseUrl } from './auth.js';
import { errorDetail } from './http.js';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_STEPS = 16; // safety valve against runaway tool loops

/**
 * Run a full conversational turn including the agentic tool loop, against
 * whichever provider the key belongs to.
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} [args.provider] - 'anthropic' | 'openai' | 'google' | 'openai-compatible'; inferred from the key/baseUrl if omitted
 * @param {string} [args.baseUrl] - base URL of an OpenAI-compatible endpoint; when set, the OpenAI path is used against it
 * @param {string} args.model
 * @param {string} args.system
 * @param {Array}  args.messages - existing history (will be appended to in place)
 * @param {Array}  args.tools - Anthropic-shaped tool definitions
 * @param {(name:string, input:object) => Promise<string>} args.dispatch - executes a tool, returns a result string
 * @param {(text:string) => void} [args.onText] - assistant text as it arrives per step
 * @param {(name:string, input:object) => void} [args.onToolUse] - notified before a tool runs
 * @returns {Promise<Array>} the updated messages array
 */
export async function converse(args) {
  const provider = args.provider || detectProvider(args.apiKey, args.baseUrl);
  if (provider === 'openai-compatible') {
    const base = normalizeBaseUrl(args.baseUrl);
    if (!base) throw new Error('No base URL set — open Settings to point Amy at your OpenAI-compatible endpoint.');
    return converseOpenAI({ ...args, endpoint: `${base}/chat/completions` });
  }
  if (!args.apiKey) throw new Error('No API key set — open Settings to connect Claude, OpenAI, or Gemini.');
  if (provider === 'google') return converseGemini(args);
  if (provider === 'openai') return converseOpenAI(args);
  return converseAnthropic(args);
}

// ---------------------------------------------------------------------------
// The shared agentic tool loop
// ---------------------------------------------------------------------------
// Every provider runs the same loop: ask the model, surface its text, and — if
// it asked to use tools — run them and feed the results back, until it stops or
// we hit the step cap. The only per-provider differences are how a step is made
// and how its reply is translated into our canonical (Anthropic-shaped) blocks;
// `step()` owns both. It must append the assistant turn to `messages` itself
// (Anthropic stores its raw content to preserve thinking blocks; the others
// store the translation) and return the canonical blocks for the loop to act on.
async function runToolLoop({ step, messages, dispatch, onText, onToolUse }) {
  for (let i = 0; i < MAX_STEPS; i++) {
    const blocks = await step();
    for (const b of blocks) if (b.type === 'text' && b.text && onText) onText(b.text);
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) return messages;
    messages.push({ role: 'user', content: await runTools(toolUses, dispatch, onToolUse) });
  }
  throw new Error(`Tool loop exceeded ${MAX_STEPS} steps; stopping to avoid a runaway.`);
}

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------
async function callAnthropic({ apiKey, model, system, messages, tools }) {
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system,
      tools,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await errorDetail(res)) || res.statusText}`);
  return res.json();
}

function converseAnthropic({ apiKey, model, system, messages, tools, dispatch, onText, onToolUse }) {
  return runToolLoop({
    messages, dispatch, onText, onToolUse,
    step: async () => {
      const response = await callAnthropic({ apiKey, model, system, messages, tools });
      // Store the assistant turn verbatim (preserves thinking + tool_use blocks).
      messages.push({ role: 'assistant', content: response.content });
      return response.content;
    },
  });
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------
// `endpoint` defaults to OpenAI's; an OpenAI-compatible provider passes its own.
// The key is sent as a Bearer token only when present (local servers may need none).
async function callOpenAI({ apiKey, model, messages, tools, endpoint }) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(endpoint || OPENAI_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'gpt-5',
      max_completion_tokens: 16000,
      messages,
      tools: tools.length ? tools : undefined,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await errorDetail(res)) || res.statusText}`);
  return res.json();
}

function converseOpenAI({ apiKey, model, system, messages, tools, dispatch, onText, onToolUse, endpoint }) {
  const openaiTools = toOpenAITools(tools);
  return runToolLoop({
    messages, dispatch, onText, onToolUse,
    step: async () => {
      const data = await callOpenAI({ apiKey, model, messages: toOpenAIMessages(system, messages), tools: openaiTools, endpoint });
      const msg = data.choices?.[0]?.message || {};
      // Translate the OpenAI message back into canonical (Anthropic-shaped) blocks
      // so storage and the transcript renderer stay provider-agnostic.
      const blocks = [];
      if (typeof msg.content === 'string' && msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      messages.push({ role: 'assistant', content: blocks });
      return blocks;
    },
  });
}

// ---------------------------------------------------------------------------
// Google (Gemini)
// ---------------------------------------------------------------------------
async function callGemini({ apiKey, model, system, contents, tools }) {
  const url = `${GEMINI_BASE}/models/${model || 'gemini-2.5-pro'}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      tools,
      generationConfig: { maxOutputTokens: 16000 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await errorDetail(res)) || res.statusText}`);
  return res.json();
}

function converseGemini({ apiKey, model, system, messages, tools, dispatch, onText, onToolUse }) {
  const geminiTools = toGeminiTools(tools);
  return runToolLoop({
    messages, dispatch, onText, onToolUse,
    step: async () => {
      const data = await callGemini({ apiKey, model, system, contents: toGeminiContents(messages), tools: geminiTools });
      const parts = data.candidates?.[0]?.content?.parts || [];
      // Translate Gemini parts back into canonical (Anthropic-shaped) blocks so
      // storage and the transcript renderer stay provider-agnostic.
      const blocks = [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) {
          blocks.push({ type: 'text', text: p.text });
        } else if (p.functionCall) {
          blocks.push({
            type: 'tool_use',
            id: 'call_' + Math.random().toString(36).slice(2, 10),
            name: p.functionCall.name,
            input: p.functionCall.args || {},
          });
        }
      }
      messages.push({ role: 'assistant', content: blocks });
      return blocks;
    },
  });
}

// ---------------------------------------------------------------------------
// Shared tool execution + Gemini translation helpers
// ---------------------------------------------------------------------------

// Execute every requested tool, returning the tool_result blocks for one user message.
async function runTools(toolUses, dispatch, onToolUse) {
  const results = [];
  for (const tu of toolUses) {
    if (onToolUse) onToolUse(tu.name, tu.input);
    let resultText, isError = false;
    try {
      resultText = await dispatch(tu.name, tu.input);
    } catch (err) {
      resultText = String(err.message || err);
      isError = true;
    }
    results.push({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: typeof resultText === 'string' ? resultText : JSON.stringify(resultText),
      is_error: isError,
    });
  }
  return results;
}

// Anthropic tool defs -> OpenAI function tools. OpenAI accepts the JSON Schema
// in input_schema directly, so no sanitizing is needed.
function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// Canonical (Anthropic-shaped) messages -> OpenAI chat `messages`. The system
// prompt becomes a leading system message; assistant tool_use blocks become
// `tool_calls`; user tool_result blocks become `tool` role messages keyed by id.
function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') {
            out.push({
              role: 'tool',
              tool_call_id: b.tool_use_id,
              content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
            });
          } else if (b.type === 'text' && b.text) {
            out.push({ role: 'user', content: b.text });
          }
        }
      }
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n');
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

// Anthropic tool defs -> Gemini functionDeclarations.
function toGeminiTools(tools) {
  const functionDeclarations = tools.map((t) => {
    const decl = { name: t.name, description: t.description };
    const params = sanitizeSchema(t.input_schema);
    // Gemini rejects an empty object schema; only attach parameters when there are some.
    if (params && params.properties && Object.keys(params.properties).length) decl.parameters = params;
    return decl;
  });
  return [{ functionDeclarations }];
}

// Gemini's schema is an OpenAPI subset and dislikes object-typed fields that
// declare no sub-properties. Demote any such field to a JSON string the model
// fills in (app dispatch tolerates string-or-object). Returns a cloned schema.
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { type: schema.type, description: schema.description };
  if (schema.required) out.required = schema.required;
  if (schema.properties) {
    out.properties = {};
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (prop && prop.type === 'object' && !prop.properties) {
        out.properties[name] = {
          type: 'string',
          description: (prop.description ? prop.description + ' ' : '') + '(pass a JSON object encoded as a string)',
        };
      } else {
        out.properties[name] = sanitizeSchema(prop);
      }
    }
  }
  return out;
}

// Canonical (Anthropic-shaped) messages -> Gemini `contents`.
function toGeminiContents(messages) {
  // tool_result blocks only carry a tool_use_id; map ids back to tool names.
  const idToName = {};
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') idToName[b.id] = b.name;
    }
  }

  const contents = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: m.content }] });
      } else if (Array.isArray(m.content)) {
        const parts = m.content
          .filter((b) => b.type === 'tool_result')
          .map((b) => ({
            functionResponse: {
              name: idToName[b.tool_use_id] || 'tool',
              response: { result: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) },
            },
          }));
        if (parts.length) contents.push({ role: 'user', parts });
      }
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} } });
        // 'thinking' blocks are Anthropic-only; drop them for Gemini.
      }
      if (parts.length) contents.push({ role: 'model', parts });
    }
  }
  return contents;
}
