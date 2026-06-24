// http.js — tiny shared helpers for the browser fetch calls auth.js and llm.js
// make to the LLM providers. Keeps the "what did the API actually say?" parsing
// in one place instead of copied around every fetch.

/**
 * Pull a human-readable message out of a failed JSON API response. Every
 * provider here wraps errors as { error: { message } }, so this returns that
 * message (or '' if the body isn't the expected shape / isn't JSON). Consumes
 * the response body, so call it once on a non-ok response.
 * @param {Response} res
 * @returns {Promise<string>}
 */
export async function errorDetail(res) {
  try { return (await res.json()).error?.message || ''; } catch { return ''; }
}
