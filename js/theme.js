// theme.js — light/dark appearance preference.
//
// The choice lives in its own localStorage key (separate from the project) so
// it survives a project reset and applies before paint via the inline script in
// index.html. Views inherit the host's CSS variables, so they restyle for free.

const KEY = 'amy.theme';

export function current() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function apply(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(KEY, t); } catch {}
  return t;
}

export function toggle() {
  return apply(current() === 'dark' ? 'light' : 'dark');
}
