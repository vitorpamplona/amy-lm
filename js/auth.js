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
  // Any service that speaks the OpenAI Chat Completions API: Ollama, LM Studio,
  // llama.cpp, OpenRouter, Groq, Together, DeepSeek, etc. Selected by supplying a
  // base URL rather than by the key's shape, so there is no default model or
  // console — both depend on the endpoint the user points at.
  'openai-compatible': {
    label: 'Your-API',
    defaultModel: '',
    keyHint: 'any key (some local servers need none)',
    consoleUrl: '',
    consoleLabel: '',
  },
};

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODELS = 'https://api.anthropic.com/v1/models';
const OPENAI_MODELS = 'https://api.openai.com/v1/models';
const GEMINI_MODELS = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Normalize an OpenAI-compatible base URL: trim, drop trailing slashes, and
 * tolerate a key pasted with the full "/chat/completions" path. Returns '' when
 * empty. The result is the prefix Amy appends "/chat/completions" or "/models" to.
 * @param {string} url
 * @returns {string}
 */
export function normalizeBaseUrl(url) {
  let u = (url || '').trim();
  if (!u) return '';
  u = u.replace(/\/+$/, '');                  // strip trailing slashes
  u = u.replace(/\/chat\/completions$/, '');  // tolerate a full completions URL
  return u;
}

/**
 * Identify the provider. A non-empty base URL means an OpenAI-compatible
 * endpoint regardless of the key's shape; otherwise it is detected from the
 * key's prefix.
 * @param {string} apiKey
 * @param {string} [baseUrl]
 * @returns {'anthropic'|'openai'|'google'|'openai-compatible'|null}
 */
export function detectProvider(apiKey, baseUrl) {
  if (normalizeBaseUrl(baseUrl)) return 'openai-compatible';
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
 * When a base URL is supplied the key is verified against that OpenAI-compatible
 * endpoint instead of one of the built-in providers (and may be blank if the
 * server needs none, e.g. a local Ollama / LM Studio).
 *
 * @param {string} apiKey
 * @param {string} [baseUrl]
 * @returns {Promise<{ provider: 'anthropic'|'openai'|'google'|'openai-compatible', models: string[] }>}
 */
export async function verifyApiKey(apiKey, baseUrl) {
  const key = (apiKey || '').trim();
  const base = normalizeBaseUrl(baseUrl);
  if (base) return verifyOpenAICompatible(key, base);
  if (!key) throw new Error('Paste your API key first.');
  const provider = detectProvider(key);
  if (!provider) {
    throw new Error('That key isn’t recognized. Use a Claude key (starts with "sk-ant-"), an OpenAI key (starts with "sk-"), or a Gemini key (starts with "AIza" or "AQ."). For any other service, add its base URL to connect in the OpenAI-compatible format.');
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

// Verify an OpenAI-compatible endpoint by listing its models. The key is sent as
// a Bearer token when present and omitted when blank (local servers like Ollama
// and LM Studio accept any/no key). The endpoint must allow browser (CORS)
// access — most local servers do; some hosted ones may not.
async function verifyOpenAICompatible(key, baseUrl) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(`${baseUrl}/models`, { headers });
  } catch (err) {
    throw new Error(`Could not reach ${baseUrl}. Check the base URL and that the server allows browser (CORS) access.`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('That endpoint rejected the key. Check the key — or leave it blank if the server doesn’t need one.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`${baseUrl} returned ${res.status}: ${detail || res.statusText}`);
  }

  // OpenAI shape is { data: [{ id }] }; tolerate a few common variants.
  let models = [];
  try {
    const data = await res.json();
    const list = data.data || data.models || (Array.isArray(data) ? data : []);
    models = list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  } catch {}
  return { provider: 'openai-compatible', models };
}
