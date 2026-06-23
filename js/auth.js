// auth.js — the "Connect to Claude" flow.
//
// Amy has no server, so there is no real OAuth: the browser cannot complete an
// OAuth token exchange against Anthropic's endpoints (they don't send CORS
// headers for third-party origins). Instead this is a guided connection — the
// user creates a key in the Anthropic Console, pastes it here, and we verify it
// live before storing it locally. The verification call uses the same
// direct-browser-access header the chat uses, so if it succeeds the key is
// genuinely usable for chatting.

// Where users create/copy a key.
export const CONSOLE_KEYS_URL = 'https://console.anthropic.com/settings/keys';

const MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models';
const VERSION = '2023-06-01';

/**
 * Verify an Anthropic API key by listing models. Resolves with a short label
 * (e.g. the newest model id) on success; throws a human-readable Error on
 * failure so the dialog can show exactly what went wrong.
 *
 * @param {string} apiKey
 * @returns {Promise<{ models: string[] }>}
 */
export async function verifyApiKey(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('Paste your API key first.');
  if (!key.startsWith('sk-ant-')) {
    throw new Error('That doesn’t look like an Anthropic key (it should start with "sk-ant-").');
  }

  let res;
  try {
    res = await fetch(`${MODELS_ENDPOINT}?limit=20`, {
      headers: {
        'x-api-key': key,
        'anthropic-version': VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
  } catch (err) {
    throw new Error('Could not reach the Anthropic API. Check your connection and try again.');
  }

  if (res.status === 401) throw new Error('Anthropic rejected that key. Double-check you copied the whole thing.');
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Anthropic API ${res.status}: ${detail || res.statusText}`);
  }

  let models = [];
  try {
    const data = await res.json();
    models = (data.data || []).map((m) => m.id);
  } catch {}
  return { models };
}
