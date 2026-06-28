// nsite-ui.js — the "Export as nsite" wizard controller.
//
// Pure dialog glue: it drives the three-stage dialog in index.html (configure →
// live progress → done) and delegates all the real work to nsite.js/blossom.js.
// Kept out of app.js so the wiring hub stays thin; call initNsiteExport() once at
// boot, passing a getter for the live project (which app.js may reassign on reset).

import * as nsite from './nsite.js';
import * as blossom from './blossom.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Wire up the export dialog.
 * @param {() => object} getProject - returns the current project (views + settings)
 */
export function initNsiteExport(getProject) {
  let busy = false;

  const stage = (name) => {
    for (const s of document.querySelectorAll('#nsite-dialog .nsite-stage')) {
      s.hidden = s.dataset.stage !== name;
    }
  };

  const showError = (msg) => {
    const el = $('#nsite-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  };

  // Refresh the live "<id>.<host>" preview as the user edits the address fields.
  const refreshUrlPreview = () => {
    const project = getProject();
    const named = $('#nsite-dialog input[name="nsite-kind"]:checked')?.value === 'named';
    $('#nsite-dtag').hidden = !named;
    const pk = project.settings.pubkey;
    const out = $('#nsite-url-preview');
    if (!pk) { out.textContent = ''; return; }
    try {
      out.textContent = nsite.hostUrlFor({
        kind: named ? nsite.KIND_NAMED : nsite.KIND_ROOT,
        pubkey: pk,
        dTag: nsite.slugify($('#nsite-dtag').value || $('#nsite-title').value || project.name),
        host: $('#nsite-host').value,
      });
    } catch { out.textContent = ''; }
  };

  async function open() {
    if (busy) return;
    const project = getProject();
    showError('');
    stage('configure');
    $('#nsite-title').value = project.name || 'My Nostr client';
    $('#nsite-desc').value = '';
    $('#nsite-dtag').value = nsite.slugify(project.name);
    $('#nsite-allvers').checked = false;
    $('#nsite-dialog input[name="nsite-kind"][value="named"]').checked = true;

    const lineages = new Set(project.views.map((v) => v.lineage));
    $('#nsite-summary').textContent = project.views.length
      ? `${lineages.size} view${lineages.size === 1 ? '' : 's'} ready to publish (${project.views.length} version${project.views.length === 1 ? '' : 's'} total).`
      : 'You have no views yet — build one before exporting.';

    const hasSigner = !!project.settings.pubkey;
    $('#nsite-need-signer').hidden = hasSigner;
    $('#nsite-start').disabled = !hasSigner || !project.views.length;

    // Prefill Blossom servers from the user's kind 10063 list (fall back to
    // public defaults). Done async so the dialog opens instantly.
    $('#nsite-servers').value = blossom.DEFAULT_BLOSSOM_SERVERS.join('\n');
    $('#nsite-servers-hint').textContent = 'Loaded from your Blossom server list (kind 10063).';
    refreshUrlPreview();
    $('#nsite-dialog').showModal();

    if (hasSigner) {
      try {
        const servers = await blossom.userBlossomServers(project.settings.pubkey, project.settings.relays, { timeout: 4000 });
        if (servers.length) {
          $('#nsite-servers').value = servers.join('\n');
          $('#nsite-servers-hint').textContent = `Loaded ${servers.length} server${servers.length === 1 ? '' : 's'} from your list (kind 10063). Edit if you like.`;
        } else {
          $('#nsite-servers-hint').textContent = 'No kind 10063 list found — using public defaults. Edit to use your own.';
        }
      } catch { /* keep the defaults already shown */ }
    }
  }

  // A line in the progress log; marks the prior step done when the next begins.
  const makeLogger = () => {
    const list = $('#nsite-log');
    list.innerHTML = '';
    let current = null;
    const settle = (cls) => { if (current) { current.classList.remove('run'); current.classList.add(cls); } };
    return {
      step(text) {
        settle('ok');
        current = document.createElement('li');
        current.className = 'run';
        current.append(document.createTextNode(text));
        list.append(current);
      },
      detail(text) {
        if (!current) return;
        let d = current.querySelector('.nsite-detail');
        if (!d) { d = document.createElement('span'); d.className = 'nsite-detail'; current.append(d); }
        d.textContent = text;
      },
      progress(done, total) { $('#nsite-progress-fill').style.width = `${Math.round((done / total) * 100)}%`; },
      finish() { settle('ok'); $('#nsite-progress-fill').style.width = '100%'; },
      fail() { settle('err'); },
    };
  };

  async function start() {
    if (busy) return;
    const project = getProject();
    if (!project.settings.pubkey) { showError('Connect your Nostr signer first.'); return; }
    busy = true;
    showError('');
    stage('progress');
    $('#nsite-progress-fill').style.width = '0';
    const log = makeLogger();

    const named = $('#nsite-dialog input[name="nsite-kind"]:checked').value === 'named';
    const opts = {
      kind: named ? nsite.KIND_NAMED : nsite.KIND_ROOT,
      dTag: $('#nsite-dtag').value,
      title: $('#nsite-title').value,
      description: $('#nsite-desc').value,
      servers: $('#nsite-servers').value.split('\n'),
      host: $('#nsite-host').value,
      includeAllVersions: $('#nsite-allvers').checked,
    };

    try {
      const result = await nsite.exportNsite(project, opts, log);
      log.finish();
      const ok = result.relayResults.filter((r) => r.ok).length;
      $('#nsite-url').value = result.siteUrl;
      $('#nsite-open').href = result.siteUrl;
      $('#nsite-done-detail').textContent =
        `Published to ${ok} relay${ok === 1 ? '' : 's'} · stored on ${result.servers.length} Blossom server${result.servers.length === 1 ? '' : 's'}. ` +
        'It may take a moment for the gateway to pick it up.';
      stage('done');
    } catch (err) {
      log.fail();
      showError(err.message || String(err));
    } finally {
      busy = false;
    }
  }

  // Listeners
  $('#btn-export-nsite').addEventListener('click', open);
  $('#nsite-start').addEventListener('click', start);
  $('#nsite-cancel').addEventListener('click', () => $('#nsite-dialog').close());
  $('#nsite-done-close').addEventListener('click', () => $('#nsite-dialog').close());
  for (const r of document.querySelectorAll('#nsite-dialog input[name="nsite-kind"]')) {
    r.addEventListener('change', refreshUrlPreview);
  }
  $('#nsite-dtag').addEventListener('input', refreshUrlPreview);
  $('#nsite-title').addEventListener('input', refreshUrlPreview);
  $('#nsite-host').addEventListener('input', refreshUrlPreview);
  // Don't let Escape abandon an in-flight upload/publish mid-way.
  $('#nsite-dialog').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  $('#nsite-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#nsite-url').value);
      $('#nsite-copy').textContent = 'Copied';
      setTimeout(() => ($('#nsite-copy').textContent = 'Copy'), 1500);
    } catch { /* clipboard blocked — the field is selectable as a fallback */ }
  });
}
