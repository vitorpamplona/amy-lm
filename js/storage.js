// storage.js — persists the whole project in localStorage so a returning
// user reloads exactly where they left off (views, chat, settings).

const KEY = 'amy.project.v1';

const DEFAULTS = {
  version: 1,
  name: 'untitled project',
  settings: {
    apiKey: '',
    provider: '', // 'anthropic' | 'google'; set when a key is connected
    model: 'claude-opus-4-8',
    relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'],
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
