// llm.js — talks to the chosen LLM (Anthropic Claude or Google Gemini) directly
// from the browser and runs the tool-use loop that lets the model build the
// client.
//
// No server: requests go straight to the provider's API using the user's own
// key (stored locally). Both providers allow direct browser access via CORS —
// Anthropic needs the direct-browser-access opt-in header; Gemini does not.
//
// The conversation is stored in one canonical (Anthropic-shaped) message format
// in app/storage; the Gemini path translates that to/from Gemini's `contents`
// shape on the way in and out, so the rest of the app never has to branch.

import { detectProvider } from './auth.js';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_STEPS = 16; // safety valve against runaway tool loops

/**
 * Run a full conversational turn including the agentic tool loop, against
 * whichever provider the key belongs to.
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} [args.provider] - 'anthropic' | 'google'; inferred from the key if omitted
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
  if (!args.apiKey) throw new Error('No API key set — open Settings to connect Claude or Gemini.');
  const provider = args.provider || detectProvider(args.apiKey);
  return provider === 'google' ? converseGemini(args) : converseAnthropic(args);
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
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Anthropic API ${res.status}: ${detail || res.statusText}`);
  }
  return res.json();
}

async function converseAnthropic({ apiKey, model, system, messages, tools, dispatch, onText, onToolUse }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await callAnthropic({ apiKey, model, system, messages, tools });

    // Record the assistant turn verbatim (preserve thinking + tool_use blocks).
    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && onText) onText(block.text);
    }

    if (response.stop_reason !== 'tool_use') return messages;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'user', content: await runTools(toolUses, dispatch, onToolUse) });
  }
  throw new Error('Tool loop exceeded 16 steps; stopping to avoid a runaway.');
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
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Gemini API ${res.status}: ${detail || res.statusText}`);
  }
  return res.json();
}

async function converseGemini({ apiKey, model, system, messages, tools, dispatch, onText, onToolUse }) {
  const geminiTools = toGeminiTools(tools);

  for (let step = 0; step < MAX_STEPS; step++) {
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

    for (const b of blocks) {
      if (b.type === 'text' && onText) onText(b.text);
    }

    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) return messages;

    messages.push({ role: 'user', content: await runTools(toolUses, dispatch, onToolUse) });
  }
  throw new Error('Tool loop exceeded 16 steps; stopping to avoid a runaway.');
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
