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
      focusWindow: (id) => call('focusWindow', String(id)),
      closeWindow: (id) => call('closeWindow', String(id)),
      closeAllWindows: () => call('closeAllWindows'),
      testPassed: () => call('testPassed'),
    };
  }
  // Fallback für Vorschau im Browser
  const demoEvents = Array.from({ length: 40 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i * 3); d.setHours([10, 10, 17, 9, 10, 18][i % 6], (i * 7) % 60);
    return { t: d.getTime(), targetId: i % 3 ? 'a' : 'b', name: i % 3 ? 'Pokémon Drop' : 'Fall Out Boy', mode: 'queue' };
  });
  let s = { running: false, platform: 'web', version: 'Vorschau', ringing: null, events: demoEvents, update: { status: 'idle', latest: '', progress: 0, message: '' }, windows: [], config: { intervalSec: 60, webhook: '', notify: true, openBrowser: false, sound: true, captchaNotify: true, captchaSound: false, tgToken: '', tgChat: '' }, targets: [], stats: { alerts: 0, errors: 0, checks: 0 }, log: [] };
  const ok = () => Promise.resolve(s);
  return {
    getState: ok,
    saveConfig: (c) => { s.config = { ...s.config, ...c }; return ok(); },
    addTarget: (t) => { s.targets.push({ intervalSec: 0, startAt: 0, windows: 1, ...t, id: s.targets.length ? Date.now().toString(36) + s.targets.length : 'a', enabled: true, status: 'Wartet' }); return ok(); },
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
    // Vorschau: Fenster nur als Beispielzeilen
    openTask: (u, n, c) => {
      const demo = [['queue', '1.284', 'ca. 12 Minuten'], ['captcha', '', ''], ['passed', '', ''], ['loading', '', ''], ['open', '', ''], ['killed', '', '']];
      for (let i = 1; i <= c; i++) { const d = demo[s.windows.length % demo.length]; s.windows.push({ id: Date.now() + i, title: c > 1 ? `${n} #${i}` : n, url: u, status: d[0], pos: d[1], wait: d[2] }); }
      return ok();
    },
    focusWindow: ok,
    closeWindow: (id) => { s.windows = s.windows.filter(w => w.id !== id); return ok(); },
    closeAllWindows: () => { s.windows = []; return ok(); },
    arrangeWindows: ok,
    testPassed: () => { s.ringing = { name: 'Test #1', url: 'https://github.com/Djlover007', title: 'Du bist dran', t: Date.now() }; return ok(); },
  };
})();

// ---- Helfer ----
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString('de-DE') : '–';
const MODE_LABEL = { queue: 'Queue-it', keyword: 'Text erscheint', gone: 'Text verschwindet', change: 'Seitenänderung' };

let state = null;
let settingsDirty = false;
const TASK_MAX = 20;
const clampWin = (v) => Math.min(TASK_MAX, Math.max(1, parseInt(v, 10) || 1));
let editingId = null;          // Ziel, das gerade im Formular bearbeitet wird
let lastWinHtml = '';
const fmtDateTime = (ms) => new Date(ms).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// Zeitstempel <-> Wert eines datetime-local-Feldes (Ortszeit)
const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => { const t = v ? new Date(v).getTime() : 0; return Number.isFinite(t) ? t : 0; };
const WIN_STATUS = { loading: ['Lädt', ''], open: ['Offen', ''], queue: ['Warteschlange', 'queue'], captcha: ['Captcha', 'warn'], passed: ['Durch', 'live'], killed: ['Angehalten', 'err'] };
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
  document.body.classList.toggle('windows', state.platform === 'windows');
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
    ['Telegram', config.tgToken && config.tgChat ? '<span class="dot ok"></span>eingerichtet' : '<span class="dot"></span>aus'],
    ['Captcha-Hinweis', config.captchaNotify !== false ? '<span class="dot ok"></span>an' + (config.captchaSound ? ' · mit Ton' : '') : '<span class="dot"></span>aus'],
    ['Prüfung', 'bis zu 4 Ziele gleichzeitig'],
  ].map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');

  renderUpdate();
  renderAlarm();
  renderStats();
  renderWindows();

  // Ziele
  const list = $('targetList');
  const listHtml = !targets.length ? '<div class="card empty">Noch keine Ziele. Füge oben eins hinzu.</div>' : targets.map(t => {
    const badge = t.lastError ? `<span class="badge err">Fehler</span>`
      : t.live ? `<span class="badge live">LIVE</span>`
      : `<span class="badge">${esc(t.status || 'Wartet')}</span>`;
    const extra = (t.intervalSec ? ` · alle ${t.intervalSec} s` : '') + (t.startAt ? ` · ⏰ Start ${esc(fmtDateTime(t.startAt))}` : '');
    return `<div class="target ${t.enabled ? '' : 'off'} ${editingId === t.id ? 'editing' : ''}">
      <div class="target-top"><span class="target-name">${esc(t.name)}</span>${badge}</div>
      <div class="target-url">${esc(t.url)}</div>
      <div class="muted" style="font-size:12px">${MODE_LABEL[t.mode] || t.mode}${t.keyword ? ` · „${esc(t.keyword)}“` : ''}${extra} · zuletzt: ${fmtTime(t.lastCheck)}${t.lastError ? ' · ' + esc(t.lastError) : ''}</div>
      <div class="target-actions">
        <button class="btn small" data-act="toggle" data-id="${t.id}">${t.enabled ? 'Pausieren' : 'Aktivieren'}</button>
        <button class="btn small" data-act="open" data-id="${t.id}">Öffnen</button>
        <button class="btn small" data-act="edit" data-id="${t.id}">Bearbeiten</button>
        ${bridge.openTask ? `<span class="task-group"><input type="number" class="task-count" data-count="${t.id}" min="1" max="${TASK_MAX}" value="${clampWin(t.windows)}" title="Wie viele Fenster gleichzeitig öffnen (1–${TASK_MAX})" /><button class="btn small" data-act="task" data-id="${t.id}" title="Öffnet die Seite in eigenen Fenstern">Eigene Fenster öffnen</button></span>` : ''}
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

// Übersicht der eigenen Fenster auf dem Dashboard
function renderWindows() {
  const wins = state.windows || [];
  $('winCard').classList.toggle('hidden', !wins.length);
  $('winCount').textContent = wins.length;
  const html = wins.map(w => {
    const [label, cls] = WIN_STATUS[w.status] || [w.status, ''];
    const info = w.status === 'queue'
      ? [w.pos ? `Platz ${esc(w.pos)}` : '', w.wait ? `Wartezeit ${esc(w.wait)}` : ''].filter(Boolean).join(' · ') || 'Platz wird nicht angezeigt'
      : w.status === 'captcha' ? 'bitte selbst lösen'
      : w.status === 'passed' ? 'Warteschlange durch – du bist dran'
      : w.status === 'killed' ? 'Android hat es geschlossen – „Zeigen“ lädt neu'
      : '';
    return `<div class="win"><span class="win-title">🦊 ${esc(w.title)}</span><span class="badge ${cls}">${label}</span><span class="win-info">${info}</span>
      <div class="row"><button class="btn small" data-win="show" data-id="${esc(w.id)}">Zeigen</button><button class="btn small" data-win="close" data-id="${esc(w.id)}">Schließen</button></div></div>`;
  }).join('');
  if (html !== lastWinHtml) { $('winList').innerHTML = html; lastWinHtml = html; }
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
  $('sCaptcha').checked = state.config.captchaNotify !== false;
  $('sCaptchaSound').checked = !!state.config.captchaSound;
  $('sTgToken').value = state.config.tgToken || '';
  $('sTgChat').value = state.config.tgChat || '';
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

// Formular lesen und prüfen (für „Hinzufügen“ und „Bearbeiten“)
function readForm() {
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
  const iv = parseInt($('fInterval').value, 10) || 0;
  if (iv && iv < 20) return alert('Das eigene Prüfintervall muss mindestens 20 Sekunden sein.');
  const startAt = fromLocalInput($('fStart').value);
  if (startAt && startAt < Date.now()) return alert('Die Startzeit liegt in der Vergangenheit.');
  return { name: name || new URL(url).host, url, mode, keyword: (mode === 'keyword' || mode === 'gone') ? keyword : '', webhook,
    intervalSec: iv, startAt, windows: clampWin($('fWindows').value) };
}

function setForm(t) {
  editingId = t ? t.id : null;
  $('fName').value = t ? t.name : ''; $('fUrl').value = t ? t.url : '';
  $('fMode').value = t ? t.mode : $('fMode').value;
  $('fKeyword').value = t ? (t.keyword || '') : ''; $('fWebhook').value = t ? (t.webhook || '') : '';
  $('fInterval').value = t && t.intervalSec ? t.intervalSec : '';
  $('fStart').value = t ? toLocalInput(t.startAt) : '';
  $('fWindows').value = t ? clampWin(t.windows) : 1;
  $('fMode').dispatchEvent(new Event('change'));
  $('formTitle').textContent = t ? `„${t.name}“ bearbeiten` : 'Neues Ziel';
  $('addTarget').textContent = t ? 'Änderungen speichern' : 'Ziel hinzufügen';
  $('cancelEdit').classList.toggle('hidden', !t);
  lastListHtml = '';
}

$('addTarget').addEventListener('click', async () => {
  const f = readForm();
  if (!f) return;
  state = editingId ? await bridge.updateTarget(editingId, f) : await bridge.addTarget(f);
  setForm(null);
  render();
});
$('cancelEdit').addEventListener('click', () => { setForm(null); render(); });

// Anzahl der Fenster beim Ziel speichern, sobald du sie änderst
$('targetList').addEventListener('change', async (e) => {
  const inp = e.target.closest('input[data-count]');
  if (!inp) return;
  const n = clampWin(inp.value);
  inp.value = n; lastListHtml = '';
  state = await bridge.updateTarget(inp.dataset.count, { windows: n });
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
    const n = clampWin(inp ? inp.value : t.windows);
    if (inp) inp.value = n;
    lastListHtml = '';
    if (n !== t.windows) await bridge.updateTarget(t.id, { windows: n });
    state = await bridge.openTask(t.url, t.name, n) || state;
  }
  if (b.dataset.act === 'edit') {
    setForm(t);
    document.querySelector('.main').scrollTop = 0; window.scrollTo(0, 0);
  }
  if (b.dataset.act === 'del' && confirm(`„${t.name}“ löschen?`)) {
    if (editingId === t.id) setForm(null);
    state = await bridge.removeTarget(t.id);
  }
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

['sInterval', 'sWebhook', 'sNotify', 'sOpen', 'sSound', 'sVibrate', 'sProxy', 'sCaptcha', 'sCaptchaSound', 'sTgToken', 'sTgChat'].forEach(id => $(id).addEventListener('input', () => { settingsDirty = true; }));

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
  const tgToken = $('sTgToken').value.trim(), tgChat = $('sTgChat').value.trim();
  if (tgToken && !/^\d+:[\w-]{20,}$/.test(tgToken)) return alert('Der Telegram Bot-Token sieht ungültig aus. Er hat die Form 123456789:ABC…');
  if (tgChat && !/^(-?\d+|@\w+)$/.test(tgChat)) return alert('Die Telegram Chat-ID ist eine Zahl (oder @kanalname).');
  if (!!tgToken !== !!tgChat) return alert('Für Telegram brauchst du beides: Bot-Token und Chat-ID.');
  state = await bridge.saveConfig({ intervalSec, webhook, notify: $('sNotify').checked, openBrowser: $('sOpen').checked,
    sound: $('sSound').checked, vibrate: $('sVibrate').checked, proxy,
    captchaNotify: $('sCaptcha').checked, captchaSound: $('sCaptchaSound').checked, tgToken, tgChat });
  fillSettings(); render();
});

$('updateBtn').addEventListener('click', async () => { state = await bridge.installUpdate(); render(); });
$('checkUpdateBtn').addEventListener('click', async () => { state = await bridge.checkUpdate(); render(); });

$('testAlert').addEventListener('click', async () => { state = await bridge.testAlert(); render(); });
$('testPassed').addEventListener('click', async () => { state = await bridge.testPassed(); render(); });

// ---- Fensterübersicht ----
$('winList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-win]');
  if (!b) return;
  const id = /^\d+$/.test(b.dataset.id) ? Number(b.dataset.id) : b.dataset.id;
  state = await (b.dataset.win === 'show' ? bridge.focusWindow(id) : bridge.closeWindow(id)) || state;
  render();
});
$('winCloseAll').addEventListener('click', async () => {
  const n = (state.windows || []).length;
  if (n > 1 && !confirm(`Alle ${n} Fenster schließen? Plätze in Warteschlangen können dabei verloren gehen.`)) return;
  state = await bridge.closeAllWindows() || state; render();
});
$('winArrange').addEventListener('click', async () => { if (bridge.arrangeWindows) state = await bridge.arrangeWindows() || state; render(); });

// ---- Ziele übertragen (Export/Import als Text) ----
const MODES = ['queue', 'keyword', 'gone', 'change'];
function exportTargets(targets) {
  return JSON.stringify({ foxqueue: 1, targets: targets.map(t => ({ name: t.name, url: t.url, mode: t.mode, keyword: t.keyword || '', webhook: t.webhook || '', intervalSec: t.intervalSec || 0, windows: clampWin(t.windows) })) });
}
/** Liest einen Export-Text. Gibt { add: [...], skipped, invalid } zurück oder wirft bei unlesbarem Text. */
function parseImport(text, existing) {
  const d = JSON.parse(text);
  const list = Array.isArray(d) ? d : d && d.targets;
  if (!Array.isArray(list)) throw new Error('kein Fox-Queue-Export');
  const key = (t) => [t.url, t.mode, t.keyword || ''].join('|');
  const seen = new Set(existing.map(key));
  const out = { add: [], skipped: 0, invalid: 0 };
  for (const t of list) {
    const ok = t && typeof t.url === 'string' && /^https?:\/\/\S+$/i.test(t.url) && MODES.includes(t.mode)
      && (!(t.mode === 'keyword' || t.mode === 'gone') || (typeof t.keyword === 'string' && t.keyword.trim()));
    if (!ok) { out.invalid++; continue; }
    const c = { name: String(t.name || new URL(t.url).host).slice(0, 80), url: t.url, mode: t.mode, keyword: String(t.keyword || ''),
      webhook: isHook(String(t.webhook || '')) ? t.webhook : '', intervalSec: Math.max(0, parseInt(t.intervalSec, 10) || 0), startAt: 0, windows: clampWin(t.windows) };
    if (c.intervalSec && c.intervalSec < 20) c.intervalSec = 20;
    if (seen.has(key(c))) { out.skipped++; continue; }
    seen.add(key(c)); out.add.push(c);
  }
  return out;
}
$('xferExport').addEventListener('click', () => {
  $('xferText').value = exportTargets(state.targets);
  $('xferMsg').textContent = state.targets.length ? `${state.targets.length} Ziel(e) exportiert – jetzt kopieren.` : 'Es gibt noch keine Ziele.';
});
$('xferCopy').addEventListener('click', async () => {
  const ta = $('xferText');
  if (!ta.value) return;
  let ok = false;
  try { await navigator.clipboard.writeText(ta.value); ok = true; } catch {}
  if (!ok) { ta.focus(); ta.select(); try { ok = document.execCommand('copy'); } catch {} }
  $('xferMsg').textContent = ok ? 'Kopiert.' : 'Kopieren ging nicht – Text markieren und selbst kopieren.';
});
$('xferImport').addEventListener('click', async () => {
  const text = $('xferText').value.trim();
  if (!text) return alert('Füge zuerst den exportierten Text ins Feld ein.');
  let r;
  try { r = parseImport(text, state.targets); } catch { return alert('Das ist kein gültiger Fox-Queue-Export.'); }
  for (const t of r.add) state = await bridge.addTarget(t);
  $('xferMsg').textContent = `${r.add.length} Ziel(e) importiert` + (r.skipped ? `, ${r.skipped} schon vorhanden` : '') + (r.invalid ? `, ${r.invalid} ungültig übersprungen` : '') + '.';
  if (r.add.length) $('xferText').value = '';
  lastListHtml = ''; render();
});

// ---- Start ----
refresh().then(fillSettings);
setInterval(refresh, 1000);

// Für die automatischen Tests
if (typeof module !== 'undefined') module.exports = { exportTargets, parseImport, toLocalInput, fromLocalInput };
