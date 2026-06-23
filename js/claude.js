// claude.js — talks to the Anthropic Messages API directly from the browser
// and runs the tool-use loop that lets the model build the client.
//
// No server: requests go straight to api.anthropic.com using the user's own
// key (stored locally) plus the direct-browser-access header for CORS.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

async function callApi({ apiKey, model, system, messages, tools }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': VERSION,
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

/**
 * Run a full conversational turn including the agentic tool loop.
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.system
 * @param {Array}  args.messages - existing history (will be appended to in place)
 * @param {Array}  args.tools - Anthropic tool definitions
 * @param {(name:string, input:object) => Promise<string>} args.dispatch - executes a tool, returns a result string
 * @param {(text:string) => void} [args.onText] - assistant text as it arrives per step
 * @param {(name:string, input:object) => void} [args.onToolUse] - notified before a tool runs
 * @returns {Promise<Array>} the updated messages array
 */
export async function converse({ apiKey, model, system, messages, tools, dispatch, onText, onToolUse }) {
  if (!apiKey) throw new Error('No Anthropic API key set — open Settings to add one.');

  // Safety valve against runaway loops.
  for (let step = 0; step < 16; step++) {
    const response = await callApi({ apiKey, model, system, messages, tools });

    // Record the assistant turn verbatim (preserve thinking + tool_use blocks).
    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && onText) onText(block.text);
    }

    if (response.stop_reason !== 'tool_use') {
      return messages;
    }

    // Execute every requested tool and return all results in ONE user message.
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
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
    messages.push({ role: 'user', content: results });
  }

  throw new Error('Tool loop exceeded 16 steps; stopping to avoid a runaway.');
}
