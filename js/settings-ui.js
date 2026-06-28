// settings-ui.js — the Settings dialog (model picker, discovery relays, project
// name). Extracted from app.js; app wires it once with initSettings(deps).
//
// deps: { getProject, persist, onSaved, refreshConnectionStatus }
//   onSaved                — apply UI side effects after a save (project name +
//                            re-mount views, since relays may have changed)
//   refreshConnectionStatus — repaint the LLM connection mirror when the dialog opens

import { verifyApiKey } from './auth.js';

const $ = (sel) => document.querySelector(sel);

export function initSettings({ getProject, persist, onSaved, refreshConnectionStatus }) {
  function openSettings() {
    const project = getProject();
    $('#set-model').value = project.settings.model;
    $('#set-relays').value = project.settings.relays.join('\n');
    $('#set-projname').value = project.name;
    populateModelOptions(project.settings.availableModels);
    refreshConnectionStatus();
    $('#settings-dialog').showModal();
  }

  // Fill the Model <datalist> with the connected provider's reported ids, and
  // reflect how many we have in the hint line. The input stays free-text, so a
  // user can always type an id the endpoint didn't list.
  function populateModelOptions(models) {
    const project = getProject();
    const list = $('#set-model-options');
    list.innerHTML = (models || []).map((m) => `<option value="${m}"></option>`).join('');
    const hint = $('#set-model-hint');
    const refresh = $('#set-refresh-models');
    const connected = !!(project.settings.provider);
    refresh.disabled = !connected;
    if (!connected) {
      hint.textContent = 'Pick from the models your connected key can use, or type any id. Connect a key to populate this list.';
    } else if (models && models.length) {
      hint.textContent = `${models.length} model${models.length === 1 ? '' : 's'} available from your connected key — pick one or type any id.`;
    } else {
      hint.textContent = 'Your endpoint didn’t list any models — type the model id manually, or hit Refresh.';
    }
  }

  // Re-query the connected key/endpoint for its current model list, without
  // reconnecting. Uses the stored credentials.
  async function refreshModelOptions() {
    const project = getProject();
    const btn = $('#set-refresh-models');
    const hint = $('#set-model-hint');
    if (!project.settings.provider) return;
    btn.disabled = true;
    hint.textContent = 'Fetching available models…';
    try {
      const { models } = await verifyApiKey(project.settings.apiKey, project.settings.baseUrl);
      project.settings.availableModels = models;
      persist();
      populateModelOptions(models);
    } catch (err) {
      hint.textContent = err.message || String(err);
      btn.disabled = false;
    }
  }

  function saveSettingsFromForm() {
    const project = getProject();
    project.settings.model = $('#set-model').value.trim() || 'claude-opus-4-8';
    project.settings.relays = $('#set-relays').value.split('\n').map((s) => s.trim()).filter(Boolean);
    project.name = $('#set-projname').value.trim() || 'untitled project';
    persist();
    onSaved();   // update the top-bar name and re-mount views with the new relays
  }

  $('#btn-settings').addEventListener('click', openSettings);
  $('#set-refresh-models').addEventListener('click', refreshModelOptions);
  $('#settings-dialog').addEventListener('close', () => {
    if ($('#settings-dialog').returnValue === 'save') saveSettingsFromForm();
  });

  return { open: openSettings };
}
