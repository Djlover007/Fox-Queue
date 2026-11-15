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
      stopAlarm: () => call('stopAlarm'),
      clearStats: () => call('clearStats'),
      openUrl: (u) => call('openUrl', u),
      openTask: (u, n, c) => call('openTask', u, n, String(c || 1)),
    };
  }
  // Fallback für Vorschau im Browser
  const demoEvents = Array.from({ length: 40 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i * 3); d.setHours([10, 10, 17, 9, 10, 18][i % 6], (i * 7) % 60);
    return { t: d.getTime(), targetId: i % 3 ? 'a' : 'b', name: i % 3 ? 'Pokémon Drop' : 'Fall Out Boy', mode: 'queue' };
  });
  let s = { running: false, platform: 'web', version: 'Vorschau', ringing: null, events: demoEvents, update: { status: 'idle', latest: '', progress: 0, message: '' }, config: { intervalSec: 60, webhook: '', notify: true, openBrowser: false, sound: true }, targets: [], stats: { alerts: 0, errors: 0, checks: 0 }, log: [] };
  const ok = () => Promise.resolve(s);
  return {
    getState: ok,
    saveConfig: (c) => { s.config = { ...s.config, ...c }; return ok(); },
    addTarget: (t) => { s.targets.push({ ...t, id: s.targets.length ? Date.now().toString(36) : 'a', enabled: true, status: 'Wartet' }); return ok(); },
    updateTarget: (id, p) => { s.targets = s.targets.map(t => t.id === id ? { ...t, ...p } : t); return ok(); },
    removeTarget: (id) => { s.targets = s.targets.filter(t => t.id !== id); return ok(); },
    start: () => { s.running = true; return ok(); },
    stop: () => { s.running = false; return ok(); },
    clearLog: () => { s.log = []; return ok(); },
    testAlert: () => { s.ringing = { name: 'Test', url: 'https://github.com/Djlover007', title: 'Test-Alarm', t: Date.now() }; return ok(); },
    stopAlarm: () => { s.ringing = null; return ok(); },
    clearStats: () => { s.events = []; return ok(); },
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
// Wie viele Fenster „Eigenes Fenster“ pro Ziel öffnet (wird auf dem Gerät gemerkt)
const TASK_MAX = 20;
const taskCount = (id) => { try { return Math.min(TASK_MAX, Math.max(1, parseInt(localStorage.getItem('taskCount_' + id), 10) || 1)); } catch { return 1; } };
const setTaskCount = (id, n) => { try { localStorage.setItem('taskCount_' + id, String(n)); } catch {} };
const openHooks = new Set();   // aufgeklappte „Discord-Kanal“-Bereiche
let lastListHtml = '', lastFeedHtml = '', lastStatsKey = '';
const isHook = (u) => /^https:\/\/(canary\.|ptb\.)?(discord|discordapp)\.com\/api\/webhooks\//.test(u);

// ---- Ton-Alarm (Windows/Browser; Android spielt den Ton nativ) ----
const siren = {
  ctx: null, osc: null, lfo: null, gain: null,
  start() {
    if (this.osc) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume();
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), l = this.ctx.createOscillator(), lg = this.ctx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      l.type = 'square'; l.frequency.value = 2.5; lg.gain.value = 220;   // wechselt zwischen zwei Tönen
      l.connect(lg); lg.connect(o.frequency);
      g.gain.value = 0.18;
      o.connect(g); g.connect(this.ctx.destination);
      o.start(); l.start();
      this.osc = o; this.lfo = l; this.gain = g;
    } catch (e) { console.warn('Ton-Alarm nicht möglich', e); }
  },
  stop() {
    try { this.osc && this.osc.stop(); this.lfo && this.lfo.stop(); } catch {}
    this.osc = this.lfo = this.gain = null;
  },
};

// ---- Navigation ----
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + btn.dataset.page));
    if (btn.dataset.page === 'settings') fillSettings();
    document.querySelector('.main').scrollTop = 0; window.scrollTo(0, 0);
  });
});

// ---- Rendering ----
function render() {
  if (!state) return;
  document.body.classList.toggle('android', state.platform === 'android');
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
  const feedHtml = !log.length ? '<div class="empty">Noch keine Einträge.</div>'
    : log.slice(0, 150).map(e => `<div class="feed-item ${esc(e.type)}"><span class="time">${fmtTime(e.t)}</span><span>${esc(e.msg)}</span></div>`).join('');
  if (feedHtml !== lastFeedHtml) { $('feed').innerHTML = feedHtml; lastFeedHtml = feedHtml; }

  // Setup
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };
  $('setupKv').innerHTML = [
    ['Ziele', targets.length ? targets.map(t => esc(t.name)).join(', ') : '<span class="muted">keine</span>'],
    ['Seiten', targets.length ? [...new Set(targets.map(t => esc(host(t.url))))].join(', ') : '–'],
    ['Intervall', `${config.intervalSec} s`],
    ['Benachrichtigung', config.notify ? '<span class="dot ok"></span>an' : '<span class="dot"></span>aus'],
    ['Ton-Alarm', (config.sound ? '<span class="dot ok"></span>an' : '<span class="dot"></span>aus')
      + (state.platform === 'android' ? (config.vibrate !== false ? ' · Vibration an' : ' · Vibration aus') : '')],
    ['Proxy', config.proxy ? '<span class="dot ok"></span>' + esc(config.proxy.replace(/\/\/[^@\/]*@/, '//***@')) : '<span class="dot"></span>direkt'],
    ['Discord-Webhook', (config.webhook ? '<span class="dot ok"></span>gesetzt' : '<span class="dot"></span>nicht gesetzt')
      + (targets.some(t => t.webhook) ? ` · ${targets.filter(t => t.webhook).length} Ziel(e) mit eigenem Kanal` : '')],
    ['Auto-Öffnen', config.openBrowser ? '<span class="dot ok"></span>an' : '<span class="dot"></span>aus (Meldung antippen)'],
    ['Prüfung', 'bis zu 4 Ziele gleichzeitig'],
  ].map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');

  renderUpdate();
  renderAlarm();
  renderStats();

  // Ziele
  const list = $('targetList');
  const listHtml = !targets.length ? '<div class="card empty">Noch keine Ziele. Füge oben eins hinzu.</div>' : targets.map(t => {
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
        ${bridge.openTask ? `<span class="task-group"><input type="number" class="task-count" data-count="${t.id}" min="1" max="${TASK_MAX}" value="${taskCount(t.id)}" title="Wie viele Fenster gleichzeitig öffnen (1–${TASK_MAX})" /><button class="btn small" data-act="task" data-id="${t.id}" title="Öffnet die Seite als eigene Fenster in der App-Übersicht">Eigene Fenster öffnen</button></span>` : ''}
        <button class="btn small" data-act="del" data-id="${t.id}">Löschen</button>
      </div>
      <details data-id="${t.id}" ${openHooks.has(t.id) ? 'open' : ''}>
        <summary>Discord-Kanal: ${t.webhook ? 'eigener Webhook' : 'Standard aus Einstellungen'}</summary>
        <div class="row">
          <input data-hook="${t.id}" value="${esc(t.webhook || '')}" placeholder="leer = Standard-Webhook" />
          <button class="btn small primary" data-act="hook" data-id="${t.id}">Speichern</button>
        </div>
      </details></div>`;
  }).join('');
  // Nicht neu zeichnen, während du tippst – und nur, wenn sich etwas geändert hat
  if (listHtml !== lastListHtml && !list.contains(document.activeElement)) { list.innerHTML = listHtml; lastListHtml = listHtml; }
}

function renderAlarm() {
  const r = state.ringing;
  $('alarmBar').classList.toggle('hidden', !r);
  if (r) $('alarmText').textContent = `${r.title || 'Alarm'}: ${r.name}`;
  if (r && state.config.sound && state.platform !== 'android') siren.start(); else siren.stop();
}

const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

function bars(counts, labels, highlight) {
  const max = Math.max(1, ...counts);
  return counts.map((n, i) => `<div class="bar ${highlight === i && n ? 'top' : ''}" title="${labels[i]}: ${n}">
      <span class="bar-n">${n || ''}</span><div class="bar-fill" style="height:${Math.round(n / max * 100)}%"></div><span class="bar-l">${labels[i]}</span></div>`).join('');
}

function renderStats() {
  const all = state.events || [];
  // Auswahl der Ziele (auch gelöschte Ziele aus der Statistik)
  const sel = $('statTarget');
  const names = new Map();
  all.forEach(e => names.set(e.targetId, e.name));
  state.targets.forEach(t => names.set(t.id, t.name));
  const optKey = [...names].map(([id, n]) => id + n).join('|');
  if (sel.dataset.key !== optKey) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Alle Ziele</option>' + [...names].map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
    sel.value = names.has(cur) ? cur : '';
    sel.dataset.key = optKey;
  }
  const ev = (sel.value ? all.filter(e => e.targetId === sel.value) : all).slice().sort((x, y) => x.t - y.t);
  const key = sel.value + '|' + ev.length + '|' + (ev.length ? ev[ev.length - 1].t : 0);
  if (key === lastStatsKey) return;
  lastStatsKey = key;

  const days = Array(7).fill(0), hours = Array(24).fill(0);
  ev.forEach(e => { const d = new Date(e.t); days[(d.getDay() + 6) % 7]++; hours[d.getHours()]++; });
  const topDay = ev.length ? days.indexOf(Math.max(...days)) : -1;
  const topHour = ev.length ? hours.indexOf(Math.max(...hours)) : -1;

  $('stTotal').textContent = ev.length;
  $('stSpan').textContent = ev.length ? `seit ${new Date(ev[0].t).toLocaleDateString('de-DE')}` : 'noch keine Daten';
  $('stDay').textContent = topDay >= 0 ? DAYS_LONG[topDay] : '–';
  $('stDayFoot').textContent = topDay >= 0 ? `${days[topDay]} von ${ev.length} Drops` : 'braucht ein paar Drops';
  $('stHour').textContent = topHour >= 0 ? `${String(topHour).padStart(2, '0')}–${String((topHour + 1) % 24).padStart(2, '0')} Uhr` : '–';
  $('stHourFoot').textContent = topHour >= 0 ? `${hours[topHour]} von ${ev.length} Drops` : 'braucht ein paar Drops';
  const last = ev[ev.length - 1];
  $('stLast').textContent = last ? new Date(last.t).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
  $('stLastFoot').textContent = last ? last.name : '–';

  $('dayBars').innerHTML = bars(days, DAYS, topDay);
  $('hourBars').innerHTML = bars(hours, hours.map((_, h) => (h % 3 === 0 ? String(h) : '')), topHour);
  $('eventList').innerHTML = ev.length
    ? ev.slice(-50).reverse().map(e => `<div class="feed-item alert"><span class="time">${new Date(e.t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}<br>${fmtTime(e.t).slice(0, 5)}</span><span>${esc(e.name)}<br><span class="muted">${MODE_LABEL[e.mode] || ''} · ${DAYS_LONG[(new Date(e.t).getDay() + 6) % 7]}</span></span></div>`).join('')
    : '<div class="empty">Sobald Fox Queue einen Drop meldet, taucht er hier auf.</div>';
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
  $('sSound').checked = state.config.sound !== false;
  $('sVibrate').checked = state.config.vibrate !== false;
  $('sProxy').value = state.config.proxy || '';
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
  const webhook = $('fWebhook').value.trim();
  if (!url) return alert('Bitte eine URL eingeben.');
  if (webhook && !isHook(webhook)) return alert('Das ist keine gültige Discord-Webhook-URL.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return alert('Die URL sieht ungültig aus.'); }
  if ((mode === 'keyword' || mode === 'gone') && !keyword) return alert('Bitte den Text eingeben, auf den geachtet werden soll.');
  state = await bridge.addTarget({ name: name || new URL(url).host, url, mode, keyword: (mode === 'keyword' || mode === 'gone') ? keyword : '', webhook });
  $('fName').value = ''; $('fUrl').value = ''; $('fKeyword').value = ''; $('fWebhook').value = '';
  render();
});

// Anzahl der Fenster merken, sobald du sie änderst
$('targetList').addEventListener('change', (e) => {
  const inp = e.target.closest('input[data-count]');
  if (!inp) return;
  const n = Math.min(TASK_MAX, Math.max(1, parseInt(inp.value, 10) || 1));
  inp.value = n; setTaskCount(inp.dataset.count, n); lastListHtml = '';
});

$('targetList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const t = state.targets.find(x => x.id === b.dataset.id);
  if (!t) return;
  if (b.dataset.act === 'toggle') state = await bridge.updateTarget(t.id, { enabled: !t.enabled });
  if (b.dataset.act === 'open') await bridge.openUrl(t.url);
  if (b.dataset.act === 'task' && bridge.openTask) {
    const inp = document.querySelector(`input[data-count="${t.id}"]`);
    const n = Math.min(TASK_MAX, Math.max(1, parseInt(inp && inp.value, 10) || 1));
    if (inp) inp.value = n;
    setTaskCount(t.id, n);
    lastListHtml = '';
    await bridge.openTask(t.url, t.name, n);
  }
  if (b.dataset.act === 'del' && confirm(`„${t.name}“ löschen?`)) state = await bridge.removeTarget(t.id);
  if (b.dataset.act === 'hook') {
    const val = document.querySelector(`input[data-hook="${t.id}"]`).value.trim();
    if (val && !isHook(val)) return alert('Das ist keine gültige Discord-Webhook-URL.');
    b.blur();
    state = await bridge.updateTarget(t.id, { webhook: val });
    openHooks.delete(t.id);
    lastListHtml = '';
  }
  render();
});

$('targetList').addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.tagName !== 'DETAILS') return;
  if (d.open) openHooks.add(d.dataset.id); else openHooks.delete(d.dataset.id);
}, true);

$('alarmStop').addEventListener('click', async () => { siren.stop(); state = await bridge.stopAlarm(); render(); });
$('alarmOpen').addEventListener('click', async () => {
  const u = state.ringing && state.ringing.url;
  siren.stop(); state = await bridge.stopAlarm();
  if (u) await bridge.openUrl(u);
  render();
});
$('statTarget').addEventListener('change', () => { lastStatsKey = ''; renderStats(); });
$('clearStats').addEventListener('click', async () => {
  if (!confirm('Die ganze Drop-Statistik löschen?')) return;
  state = await bridge.clearStats(); lastStatsKey = ''; render();
});

['sInterval', 'sWebhook', 'sNotify', 'sOpen', 'sSound', 'sVibrate', 'sProxy'].forEach(id => $(id).addEventListener('input', () => { settingsDirty = true; }));

$('saveSettings').addEventListener('click', async () => {
  const intervalSec = Math.max(20, parseInt($('sInterval').value, 10) || 60);
  const webhook = $('sWebhook').value.trim();
  if (webhook && !isHook(webhook)) {
    return alert('Das ist keine gültige Discord-Webhook-URL.');
  }
  let proxy = $('sProxy').value.trim();
  // Anbieter-Format host:port:nutzer:passwort automatisch umwandeln
  const m = proxy.match(/^(?:(https?|socks5?):\/\/)?([^\s:@\/]+):(\d{1,5}):([^\s:]+):(.+)$/i);
  if (m) {
    proxy = `${(m[1] || 'http').toLowerCase()}://${encodeURIComponent(m[4])}:${encodeURIComponent(m[5])}@${m[2]}:${m[3]}`;
  } else if (/^[^\s:@\/]+:\d{1,5}$/.test(proxy)) {
    proxy = 'http://' + proxy;
  }
  $('sProxy').value = proxy;
  if (proxy && !/^https?:\/\/([^\s:@\/]+(:[^\s@\/]*)?@)?[^\s:@\/]+:\d{1,5}\/?$/i.test(proxy)) {
    return alert('Proxy bitte so eingeben: http://host:port oder http://nutzer:passwort@host:port');
  }
  state = await bridge.saveConfig({ intervalSec, webhook, notify: $('sNotify').checked, openBrowser: $('sOpen').checked,
    sound: $('sSound').checked, vibrate: $('sVibrate').checked, proxy });
  fillSettings(); render();
});

$('updateBtn').addEventListener('click', async () => { state = await bridge.installUpdate(); render(); });
$('checkUpdateBtn').addEventListener('click', async () => { state = await bridge.checkUpdate(); render(); });

$('testAlert').addEventListener('click', async () => { state = await bridge.testAlert(); render(); });

// ---- Start ----
refresh().then(fillSettings);
setInterval(refresh, 1000);
