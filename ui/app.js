// Fox Queue – gemeinsame Oberfläche für Windows (Electron) und Android (WebView)

// ---- Brücke zur jeweiligen Plattform ----
const bridge = (() => {
  if (window.fox) return window.fox; // Electron (preload.js)
  if (window.AndroidFox) {
    const A = window.AndroidFox;
    const call = (fn, ...args) => {
      try {
        const res = A[fn](...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))));
        return Promise.resolve(res ? JSON.parse(res) : null);
      } catch (e) { return Promise.reject(e); }
    };
    return {
      getState: () => call('getState'),
      saveConfig: (c) => call('saveConfig', c),
      addTarget: (t) => call('addTarget', t),
      updateTarget: (id, p) => call('updateTarget', id, p),
      removeTarget: (id) => call('removeTarget', id),
      start: () => call('start'),
      stop: () => call('stop'),
      clearLog: () => call('clearLog'),
      testAlert: () => call('testAlert'),
      checkUpdate: () => call('checkUpdate'),
      installUpdate: () => call('installUpdate'),
      openUrl: (u) => call('openUrl', u),
    };
  }
  // Fallback für Vorschau im Browser
  let s = { running: false, platform: 'web', version: 'Vorschau', update: { status: 'available', latest: '1.0.9', progress: 0, message: '' }, config: { intervalSec: 60, webhook: '', notify: true, openBrowser: false }, targets: [], stats: { alerts: 0, errors: 0, checks: 0 }, log: [] };
  const ok = () => Promise.resolve(s);
  return {
    getState: ok,
    saveConfig: (c) => { s.config = { ...s.config, ...c }; return ok(); },
    addTarget: (t) => { s.targets.push({ ...t, id: Date.now().toString(36), enabled: true, status: 'Wartet' }); return ok(); },
    updateTarget: (id, p) => { s.targets = s.targets.map(t => t.id === id ? { ...t, ...p } : t); return ok(); },
    removeTarget: (id) => { s.targets = s.targets.filter(t => t.id !== id); return ok(); },
    start: () => { s.running = true; return ok(); },
    stop: () => { s.running = false; return ok(); },
    clearLog: () => { s.log = []; return ok(); },
    testAlert: () => ok(),
    checkUpdate: () => ok(),
    installUpdate: () => ok(),
    openUrl: (u) => { window.open(u, '_blank'); return ok(); },
  };
})();

// ---- Helfer ----
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString('de-DE') : '–';
const MODE_LABEL = { queue: 'Queue-it', keyword: 'Text erscheint', gone: 'Text verschwindet', change: 'Seitenänderung' };

let state = null;
let settingsDirty = false;

// ---- Navigation ----
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + btn.dataset.page));
    if (btn.dataset.page === 'settings') fillSettings();
  });
});

// ---- Rendering ----
function render() {
  if (!state) return;
  const { running, config, targets, stats, log } = state;
  const active = targets.filter(t => t.enabled);
  const live = targets.filter(t => t.live);

  $('runDot').className = 'dot ' + (running ? 'run' : '');
  $('runState').textContent = running ? 'Läuft' : 'Gestoppt';
  $('runHint').textContent = running
    ? `${active.length} Ziel(e) werden alle ${config.intervalSec} s geprüft.`
    : 'Es passiert nichts, bis du startest.';
  $('toggleBtn').textContent = running ? 'Stop' : 'Start';
  $('toggleBtn').className = 'btn ' + (running ? 'danger' : 'primary');

  $('sideRunDot').className = 'dot ' + (running ? 'run' : '');
  $('sideRunText').textContent = running ? 'Monitor läuft' : 'Gestoppt';
  $('sideHookDot').className = 'dot ' + (config.webhook ? 'ok' : '');
  $('sideHookText').textContent = 'Discord: ' + (config.webhook ? 'gesetzt' : 'aus');

  $('navTargetCount').textContent = targets.length;
  $('tTargets').textContent = targets.length;
  $('tTargetsFoot').textContent = `${active.length} aktiv`;
  $('tOpen').textContent = live.length;
  $('tAlerts').textContent = stats.alerts;
  $('tErrors').textContent = stats.errors;
  $('tChecks').textContent = stats.checks;
  $('tInterval').textContent = `alle ${config.intervalSec} s`;

  // Feed
  const feed = $('feed');
  if (!log.length) feed.innerHTML = '<div class="empty">Noch keine Einträge.</div>';
  else feed.innerHTML = log.slice(0, 150).map(e =>
    `<div class="feed-item ${esc(e.type)}"><span class="time">${fmtTime(e.t)}</span><span>${esc(e.msg)}</span></div>`).join('');

  // Setup
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };
  $('setupKv').innerHTML = [
    ['Ziele', targets.length ? targets.map(t => esc(t.name)).join(', ') : '<span class="muted">keine</span>'],
    ['Seiten', targets.length ? [...new Set(targets.map(t => esc(host(t.url))))].join(', ') : '–'],
    ['Intervall', `${config.intervalSec} s`],
    ['Benachrichtigung', config.notify ? '<span class="dot ok"></span>an' : '<span class="dot"></span>aus'],
    ['Discord-Webhook', config.webhook ? '<span class="dot ok"></span>gesetzt' : '<span class="dot"></span>nicht gesetzt'],
    ['Auto-Öffnen', state.platform === 'android' ? 'per Antippen der Meldung' : (config.openBrowser ? 'an' : 'aus')],
  ].map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');

  renderUpdate();

  // Ziele
  const list = $('targetList');
  if (!targets.length) { list.innerHTML = '<div class="card empty">Noch keine Ziele. Füge oben eins hinzu.</div>'; return; }
  list.innerHTML = targets.map(t => {
    const badge = t.lastError ? `<span class="badge err">Fehler</span>`
      : t.live ? `<span class="badge live">LIVE</span>`
      : `<span class="badge">${esc(t.status || 'Wartet')}</span>`;
    return `<div class="target ${t.enabled ? '' : 'off'}">
      <div class="target-top"><span class="target-name">${esc(t.name)}</span>${badge}</div>
      <div class="target-url">${esc(t.url)}</div>
      <div class="muted" style="font-size:12px">${MODE_LABEL[t.mode] || t.mode}${t.keyword ? ` · „${esc(t.keyword)}“` : ''} · zuletzt: ${fmtTime(t.lastCheck)}${t.lastError ? ' · ' + esc(t.lastError) : ''}</div>
      <div class="target-actions">
        <button class="btn small" data-act="toggle" data-id="${t.id}">${t.enabled ? 'Pausieren' : 'Aktivieren'}</button>
        <button class="btn small" data-act="open" data-id="${t.id}">Öffnen</button>
        <button class="btn small" data-act="del" data-id="${t.id}">Löschen</button>
      </div></div>`;
  }).join('');
}

const UPDATE_STATUS = {
  idle: 'noch nicht geprüft', checking: 'wird geprüft …', latest: 'aktuell', available: 'Update verfügbar',
  downloading: 'wird geladen …', ready: 'bereit zur Installation', installing: 'wird installiert …', error: 'Fehler',
};

function renderUpdate() {
  const u = state.update || { status: 'idle' };
  $('brandVersion').textContent = 'Version ' + (state.version || '–');
  $('uCurrent').textContent = state.version || '–';
  $('uLatest').textContent = u.latest || '–';
  $('uStatus').textContent = (UPDATE_STATUS[u.status] || u.status) + (u.message ? ' – ' + u.message : '');

  const show = ['available', 'downloading', 'ready', 'installing'].includes(u.status) || (u.message && u.status === 'available');
  $('updateBar').classList.toggle('hidden', !show);
  if (!show) return;
  const busy = u.status === 'downloading' || u.status === 'installing';
  $('updateProgress').classList.toggle('hidden', !busy);
  $('updateProgressFill').style.width = (u.progress || 0) + '%';
  $('updateBtn').classList.toggle('hidden', busy);
  const isPortableLike = state.platform === 'windows' && u.status === 'available';
  $('updateBtn').textContent = u.status === 'ready' ? 'Neu starten & installieren' : (isPortableLike ? 'Herunterladen' : 'Jetzt aktualisieren');
  $('updateText').textContent =
    u.status === 'downloading' ? `🦊 Update ${u.latest} wird geladen … ${u.progress || 0} %`
    : u.status === 'installing' ? `🦊 Update ${u.latest} wird installiert …`
    : u.status === 'ready' ? `🦊 Update ${u.latest} ist bereit.`
    : `🦊 Neue Version ${u.latest} verfügbar.` + (u.message ? ' ' + u.message : '');
}

function fillSettings() {
  if (!state) return;
  $('sInterval').value = state.config.intervalSec;
  $('sWebhook').value = state.config.webhook || '';
  $('sNotify').checked = !!state.config.notify;
  $('sOpen').checked = !!state.config.openBrowser;
  settingsDirty = false;
}

async function refresh() {
  try { state = await bridge.getState(); render(); } catch (e) { console.error(e); }
}

// ---- Aktionen ----
$('toggleBtn').addEventListener('click', async () => {
  if (!state) return;
  if (!state.running && !state.targets.some(t => t.enabled)) {
    alert('Füge zuerst unter „Ziele“ mindestens eine Seite hinzu.');
    return;
  }
  state = await (state.running ? bridge.stop() : bridge.start());
  render();
});

$('clearLog').addEventListener('click', async () => { state = await bridge.clearLog(); render(); });

$('fMode').addEventListener('change', () => {
  const m = $('fMode').value;
  $('fKeywordWrap').classList.toggle('hidden', !(m === 'keyword' || m === 'gone'));
  $('fKeyword').placeholder = m === 'gone' ? 'Ausverkauft' : 'In den Warenkorb';
});

$('addTarget').addEventListener('click', async () => {
  const name = $('fName').value.trim();
  let url = $('fUrl').value.trim();
  const mode = $('fMode').value;
  const keyword = $('fKeyword').value.trim();
  if (!url) return alert('Bitte eine URL eingeben.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return alert('Die URL sieht ungültig aus.'); }
  if ((mode === 'keyword' || mode === 'gone') && !keyword) return alert('Bitte den Text eingeben, auf den geachtet werden soll.');
  state = await bridge.addTarget({ name: name || new URL(url).host, url, mode, keyword: (mode === 'keyword' || mode === 'gone') ? keyword : '' });
  $('fName').value = ''; $('fUrl').value = ''; $('fKeyword').value = '';
  render();
});

$('targetList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const t = state.targets.find(x => x.id === b.dataset.id);
  if (!t) return;
  if (b.dataset.act === 'toggle') state = await bridge.updateTarget(t.id, { enabled: !t.enabled });
  if (b.dataset.act === 'open') await bridge.openUrl(t.url);
  if (b.dataset.act === 'del' && confirm(`„${t.name}“ löschen?`)) state = await bridge.removeTarget(t.id);
  render();
});

['sInterval', 'sWebhook', 'sNotify', 'sOpen'].forEach(id => $(id).addEventListener('input', () => { settingsDirty = true; }));

$('saveSettings').addEventListener('click', async () => {
  const intervalSec = Math.max(20, parseInt($('sInterval').value, 10) || 60);
  const webhook = $('sWebhook').value.trim();
  if (webhook && !/^https:\/\/(canary\.|ptb\.)?(discord|discordapp)\.com\/api\/webhooks\//.test(webhook)) {
    return alert('Das ist keine gültige Discord-Webhook-URL.');
  }
  state = await bridge.saveConfig({ intervalSec, webhook, notify: $('sNotify').checked, openBrowser: $('sOpen').checked });
  fillSettings(); render();
});

$('updateBtn').addEventListener('click', async () => { state = await bridge.installUpdate(); render(); });
$('checkUpdateBtn').addEventListener('click', async () => { state = await bridge.checkUpdate(); render(); });

$('testAlert').addEventListener('click', async () => { state = await bridge.testAlert(); render(); });

// ---- Start ----
refresh().then(fillSettings);
setInterval(refresh, 1000);
