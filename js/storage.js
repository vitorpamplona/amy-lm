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
    // Model ids the connected provider/key reported at login (or via the
    // "Refresh" button in Settings). Used to populate the Model picker. Not
    // authoritative — the user may still type any id, e.g. for an endpoint that
    // doesn't list its models.
    availableModels: [],
    relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    // Remembered NIP-07 identity so a returning nostr user is recognized
    // without reconnecting. pubkey is hex; profile caches { name, picture } so
    // the avatar can paint instantly on load before the network responds.
    pubkey: '',
    profile: null,
  },
  // Each view: { id, title, lineage, version, code, createdAt, state }
  // lineage groups the successive versions of one logical view; version is 1-based.
  views: [],
  // Anthropic-shaped message history: { role, content }
  chat: [],
};

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// Backfill versioning on views saved before lineages existed: each old view
// becomes the sole (v1) member of its own lineage.
function migrateView(v) {
  if (v.lineage && v.version) return v;
  return { ...v, lineage: v.lineage || v.id, version: v.version || 1 };
}

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
      views: (parsed.views || []).map(migrateView),
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
