// connect-ui.js — the LLM "Log in" dialog and the connection status it drives
// (the top-bar pill, the Log in / provider button, and the Settings mirror).
// Extracted from app.js; app wires it once with initConnect(deps) and uses the
// returned handle to query/refresh connection state and open the dialog.
//
// deps: { getProject, persist, setStatus, afterConnect }
//   afterConnect — run after a successful login (the signer nudge)

import { verifyApiKey, detectProvider, normalizeBaseUrl, PROVIDERS } from './auth.js';

const $ = (sel) => document.querySelector(sel);

export function initConnect({ getProject, persist, setStatus, afterConnect }) {
  function maskKey(key) {
    if (!key) return '';
    return key.length <= 12 ? key : key.slice(0, 7) + '…' + key.slice(-4);
  }

  // Connected when there's a key, or an OpenAI-compatible base URL (which may
  // need no key, e.g. a local Ollama / LM Studio).
  function isConnected() {
    const s = getProject().settings;
    return !!s.apiKey || !!s.baseUrl;
  }

  function refreshClaudeStatus() {
    const project = getProject();
    const connected = isConnected();
    const provider = project.settings.provider || detectProvider(project.settings.apiKey, project.settings.baseUrl);
    const label = provider ? PROVIDERS[provider].label : 'LLM';
    const pill = $('#claude-status');
    // The green `.ok` styling already signals "connected", so the word is redundant;
    // a leading dot marks the live state for anyone who can't perceive the color shift.
    pill.textContent = connected ? `● ${label}` : 'not connected';
    pill.classList.toggle('ok', connected);
    $('#btn-connect-claude').textContent = connected ? label : 'Log in';
    // Settings mirror, if present.
    const state = $('#set-claude-state');
    if (state) {
      // For an OpenAI-compatible endpoint, show the URL (and key if any); otherwise the masked key.
      const detail = provider === 'openai-compatible'
        ? project.settings.baseUrl + (project.settings.apiKey ? `, ${maskKey(project.settings.apiKey)}` : '')
        : maskKey(project.settings.apiKey);
      state.textContent = connected ? `Connected to ${label} (${detail}).` : 'Not connected.';
      state.classList.toggle('ok', connected);
    }
    const manage = $('#set-manage-claude');
    if (manage) manage.textContent = connected ? 'Manage' : 'Log in';
  }

  function setConnectStatus(text, kind = '') {
    const el = $('#connect-status');
    el.textContent = text;
    el.className = 'connect-status' + (kind ? ' ' + kind : '');
  }

  function openConnect() {
    const project = getProject();
    $('#connect-open-anthropic').href = PROVIDERS.anthropic.consoleUrl;
    $('#connect-open-openai').href = PROVIDERS.openai.consoleUrl;
    $('#connect-open-google').href = PROVIDERS.google.consoleUrl;
    $('#connect-apikey').value = project.settings.apiKey || '';
    $('#connect-baseurl').value = project.settings.baseUrl || '';
    $('#connect-disconnect').hidden = !isConnected();
    setConnectStatus(isConnected() ? 'Connected. Paste a new key (or base URL) to replace it.' : '');
    if ($('#settings-dialog').open) $('#settings-dialog').close();
    $('#connect-dialog').showModal();
    $('#connect-apikey').focus();
  }

  // Live hint as the user types, so they know which provider they'll connect to.
  function reflectDetectedProvider() {
    const key = $('#connect-apikey').value.trim();
    const baseUrl = $('#connect-baseurl').value.trim();
    // A base URL wins: it routes to the OpenAI-compatible path regardless of key shape.
    if (baseUrl) { setConnectStatus('Will connect to your OpenAI-compatible endpoint.', 'ok'); return; }
    if (!key) { setConnectStatus(''); return; }
    const provider = detectProvider(key);
    if (provider) setConnectStatus(`Detected a ${PROVIDERS[provider].label} key.`, 'ok');
    else setConnectStatus('Unrecognized key — expected sk-ant-… (Claude), sk-… (OpenAI), or AIza…/AQ.… (Gemini). For any other service, add its base URL below.', '');
  }

  async function submitConnect() {
    const project = getProject();
    const key = $('#connect-apikey').value.trim();
    const baseUrl = $('#connect-baseurl').value.trim();
    const submit = $('#connect-submit');
    submit.disabled = true;
    const detected = detectProvider(key, baseUrl);
    setConnectStatus(detected ? `Verifying with ${PROVIDERS[detected].label}…` : 'Verifying…', '');
    try {
      const { provider, models } = await verifyApiKey(key, baseUrl);
      project.settings.apiKey = key;
      project.settings.provider = provider;
      project.settings.baseUrl = provider === 'openai-compatible' ? normalizeBaseUrl(baseUrl) : '';
      project.settings.availableModels = models; // remember for the Model picker in Settings
      // If the endpoint listed models and the configured one isn't among them, fall
      // back to the provider default (or the first listed) so the first message works.
      // When no models are listed (some compatible servers omit /models), keep the
      // user's current model — they can change it in Settings.
      if (models.length && !models.includes(project.settings.model)) {
        const def = PROVIDERS[provider].defaultModel;
        project.settings.model = models.includes(def) ? def : models[0];
      }
      persist();
      refreshClaudeStatus();
      // For a compatible endpoint, nudge the user to confirm the model when we
      // couldn't pick one from the endpoint (no model set, or it listed none).
      const needsModel = provider === 'openai-compatible' && (!project.settings.model || !models.length);
      const hint = needsModel
        ? ` Set the model name in Settings (currently "${project.settings.model || 'none'}") to match this endpoint before chatting.`
        : ' You can close this and start chatting.';
      setConnectStatus(`Connected to ${PROVIDERS[provider].label}!${hint}`, 'ok');
      setStatus('');
      afterConnect();
      setTimeout(() => $('#connect-dialog').close(), 700);
    } catch (err) {
      setConnectStatus(err.message || String(err), 'error');
    } finally {
      submit.disabled = false;
    }
  }

  function disconnectClaude() {
    const project = getProject();
    project.settings.apiKey = '';
    project.settings.provider = '';
    project.settings.baseUrl = '';
    project.settings.availableModels = [];
    persist();
    refreshClaudeStatus();
    $('#connect-apikey').value = '';
    $('#connect-baseurl').value = '';
    $('#connect-disconnect').hidden = true;
    setConnectStatus('Disconnected.', '');
  }

  // Both the top-bar button and the Settings "Manage" link open the dialog.
  $('#btn-connect-claude').addEventListener('click', openConnect);
  $('#set-manage-claude').addEventListener('click', openConnect);
  $('#connect-submit').addEventListener('click', submitConnect);
  $('#connect-cancel').addEventListener('click', () => $('#connect-dialog').close());
  $('#connect-disconnect').addEventListener('click', disconnectClaude);
  $('#connect-apikey').addEventListener('input', reflectDetectedProvider);
  $('#connect-baseurl').addEventListener('input', reflectDetectedProvider);
  $('#connect-apikey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitConnect(); }
  });
  $('#connect-baseurl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitConnect(); }
  });

  return { isConnected, refreshStatus: refreshClaudeStatus, open: openConnect };
}
