// auth.js — the "Log in" flow, for Claude (Anthropic), Gemini (Google) or
// OpenAI.
//
// Amy has no server, so there is no OAuth: you create an API key in your
// provider's console, paste it here, and we verify it live before storing it
// locally. All three providers' inference endpoints allow direct browser access
// (CORS), so a verified key is genuinely usable for chatting straight away.
//
// The provider is detected from the key's shape: Anthropic keys start with
// "sk-ant-", OpenAI keys with "sk-" (anything else), and Google AI Studio keys
// with "AIza" (legacy) or "AQ." (current).

// Per-provider connection metadata (labels, defaults, where to make a key).
export const PROVIDERS = {
  anthropic: {
    label: 'Claude',
    defaultModel: 'claude-opus-4-8',
    keyHint: 'sk-ant-…',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    consoleLabel: 'Anthropic Console',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5',
    keyHint: 'sk-…',
    consoleUrl: 'https://platform.openai.com/api-keys',
    consoleLabel: 'OpenAI Platform',
  },
  google: {
    label: 'Gemini',
    defaultModel: 'gemini-2.5-pro',
    keyHint: 'AIza…/AQ.…',
    consoleUrl: 'https://aistudio.google.com/apikey',
    consoleLabel: 'Google AI Studio',
  },
};

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODELS = 'https://api.anthropic.com/v1/models';
const OPENAI_MODELS = 'https://api.openai.com/v1/models';
const GEMINI_MODELS = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Identify the provider from an API key's prefix.
 * @param {string} apiKey
 * @returns {'anthropic'|'openai'|'google'|null}
 */
export function detectProvider(apiKey) {
  const key = (apiKey || '').trim();
  if (key.startsWith('sk-ant-')) return 'anthropic';
  // OpenAI keys are "sk-…" (incl. "sk-proj-…", "sk-svcacct-…"); checked after
  // Anthropic so its more specific "sk-ant-" prefix wins.
  if (key.startsWith('sk-')) return 'openai';
  // Google AI Studio keys: "AIza…" (legacy) and "AQ.…" (current format).
  if (key.startsWith('AIza') || key.startsWith('AQ.')) return 'google';
  return null;
}

/**
 * Verify an API key by listing the account's models. Resolves with the detected
 * provider and the available model ids on success; throws a human-readable
 * Error on failure so the dialog can show exactly what went wrong.
 *
 * @param {string} apiKey
 * @returns {Promise<{ provider: 'anthropic'|'openai'|'google', models: string[] }>}
 */
export async function verifyApiKey(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('Paste your API key first.');
  const provider = detectProvider(key);
  if (!provider) {
    throw new Error('That key isn’t recognized. Use a Claude key (starts with "sk-ant-"), an OpenAI key (starts with "sk-"), or a Gemini key (starts with "AIza" or "AQ.").');
  }
  if (provider === 'anthropic') return verifyAnthropic(key);
  if (provider === 'openai') return verifyOpenAI(key);
  return verifyGoogle(key);
}

async function verifyAnthropic(key) {
  let res;
  try {
    res = await fetch(`${ANTHROPIC_MODELS}?limit=20`, {
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
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
  return { provider: 'anthropic', models };
}

async function verifyOpenAI(key) {
  let res;
  try {
    res = await fetch(OPENAI_MODELS, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    throw new Error('Could not reach the OpenAI API. Check your connection and try again.');
  }

  if (res.status === 401) throw new Error('OpenAI rejected that key. Double-check you copied the whole thing.');
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`OpenAI API ${res.status}: ${detail || res.statusText}`);
  }

  let models = [];
  try {
    const data = await res.json();
    models = (data.data || []).map((m) => m.id);
  } catch {}
  return { provider: 'openai', models };
}

async function verifyGoogle(key) {
  let res;
  try {
    res = await fetch(`${GEMINI_MODELS}?pageSize=100`, {
      headers: { 'x-goog-api-key': key },
    });
  } catch (err) {
    throw new Error('Could not reach the Gemini API. Check your connection and try again.');
  }

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error('Google rejected that key. Double-check you copied the whole thing.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Gemini API ${res.status}: ${detail || res.statusText}`);
  }

  let models = [];
  try {
    const data = await res.json();
    models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => (m.name || '').replace(/^models\//, ''));
  } catch {}
  return { provider: 'google', models };
}
