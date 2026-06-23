// storage.js — persists the whole project in localStorage so a returning
// user reloads exactly where they left off (views, chat, settings).

const KEY = 'amy.project.v1';

const DEFAULTS = {
  version: 1,
  name: 'untitled project',
  settings: {
    apiKey: '',
    provider: '', // 'anthropic' | 'openai' | 'google' | 'openai-compatible'; set when a key is connected
    // Base URL for an OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter,
    // Groq, Together, …). When set, Amy talks to it in the OpenAI format instead
    // of one of the built-in providers. Empty for Claude / OpenAI / Gemini.
    baseUrl: '',
    model: 'claude-opus-4-8',
    relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    // Remembered NIP-07 identity so a returning nostr user is recognized
    // without reconnecting. pubkey is hex; profile caches { name, picture } so
    // the avatar can paint instantly on load before the network responds.
    pubkey: '',
    profile: null,
  },
  // Each view: { id, title, code, createdAt }
  views: [],
  // Anthropic-shaped message history: { role, content }
  chat: [],
};

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return deepClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    // Merge so new default fields appear for old saved projects.
    return {
      ...deepClone(DEFAULTS),
      ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      views: parsed.views || [],
      chat: parsed.chat || [],
    };
  } catch (e) {
    console.warn('Failed to load project, starting fresh', e);
    return deepClone(DEFAULTS);
  }
}

export function save(project) {
  try {
    localStorage.setItem(KEY, JSON.stringify(project));
  } catch (e) {
    console.error('Failed to save project', e);
  }
}

export function reset() {
  localStorage.removeItem(KEY);
}
