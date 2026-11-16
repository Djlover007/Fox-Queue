const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const UI = path.join(__dirname, '..', 'ui');

/** Lädt die Oberfläche mit der eingebauten Vorschau-Brücke (ohne Android/Electron). */
async function loadUi() {
  const errors = [];
  const dom = new JSDOM(fs.readFileSync(path.join(UI, 'index.html'), 'utf8').replace('<script src="app.js"></script>', ''), { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.alert = (m) => { errors.push('alert: ' + m); };
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.eval(fs.readFileSync(path.join(UI, 'app.js'), 'utf8'));
  const $ = (id) => window.document.getElementById(id);
  const tick = () => new Promise(r => setTimeout(r, 30));
  await tick();
  return { window, $, tick, errors };
}

test('Oberfläche: Ziel anlegen, bearbeiten, Fenster öffnen, exportieren und importieren', async () => {
  const { window, $, tick, errors } = await loadUi();
  try {
    // Ziel anlegen – mit eigenem Intervall und 3 Fenstern
    $('fName').value = 'Fall Out Boy'; $('fUrl').value = 'eventim.de/fob'; $('fInterval').value = '30'; $('fWindows').value = '3';
    $('addTarget').click(); await tick();
    assert.match($('targetList').innerHTML, /Fall Out Boy/);
    assert.match($('targetList').innerHTML, /alle 30 s/);
    assert.equal($('fName').value, '', 'Formular ist nach dem Anlegen leer');

    // Bearbeiten: Name ändern
    $('targetList').querySelector('button[data-act="edit"]').click(); await tick();
    assert.equal($('fUrl').value, 'https://eventim.de/fob');
    assert.equal($('addTarget').textContent, 'Änderungen speichern');
    $('fName').value = 'FOB Berlin'; $('addTarget').click(); await tick();
    assert.match($('targetList').innerHTML, /FOB Berlin/);
    assert.doesNotMatch($('targetList').innerHTML, /Fall Out Boy/);
    assert.equal($('addTarget').textContent, 'Ziel hinzufügen');

    // Eigene Fenster öffnen → Übersicht auf dem Dashboard
    $('targetList').querySelector('button[data-act="task"]').click(); await tick();
    assert.equal($('winCard').classList.contains('hidden'), false);
    assert.equal($('winList').querySelectorAll('.win').length, 3);
    assert.match($('winList').innerHTML, /Platz 1\.284/);
    $('winList').querySelector('button[data-win="close"]').click(); await tick();
    assert.equal($('winList').querySelectorAll('.win').length, 2);
    $('winCloseAll').click(); await tick();
    assert.equal($('winCard').classList.contains('hidden'), true);

    // Export → löschen → Import bringt das Ziel zurück, zweiter Import legt nichts doppelt an
    $('xferExport').click();
    const text = $('xferText').value;
    assert.match(text, /"foxqueue":1/);
    $('targetList').querySelector('button[data-act="del"]').click(); await tick();
    assert.doesNotMatch($('targetList').innerHTML, /FOB Berlin/);
    $('xferText').value = text; $('xferImport').click(); await tick();
    assert.match($('targetList').innerHTML, /FOB Berlin/);
    assert.match($('xferMsg').textContent, /1 Ziel\(e\) importiert/);
    $('xferText').value = text; $('xferImport').click(); await tick();
    assert.match($('xferMsg').textContent, /0 Ziel\(e\) importiert, 1 schon vorhanden/);
    assert.equal(window.document.querySelectorAll('#targetList .target').length, 1);

    // Kaputter Import-Text wird abgelehnt
    $('xferText').value = 'kein export'; $('xferImport').click(); await tick();
    assert.equal(errors.pop(), 'alert: Das ist kein gültiger Fox-Queue-Export.');

    // Test „Du bist dran“ zeigt den Alarmbalken
    $('testPassed').click(); await tick();
    assert.equal($('alarmBar').classList.contains('hidden'), false);
    assert.match($('alarmText').textContent, /Du bist dran/);

    assert.deepEqual(errors, []);
  } finally {
    window.close();
  }
});

test('Oberfläche: ungültige Eingaben werden abgefangen', async () => {
  const { window, $, tick, errors } = await loadUi();
  try {
    $('fUrl').value = 'shop.de'; $('fInterval').value = '5';
    $('addTarget').click(); await tick();
    assert.match(errors.pop(), /mindestens 20 Sekunden/);
    $('fInterval').value = ''; $('fStart').value = '2020-01-01T10:00';
    $('addTarget').click(); await tick();
    assert.match(errors.pop(), /Vergangenheit/);
    assert.equal(window.document.querySelectorAll('#targetList .target').length, 0);
  } finally {
    window.close();
  }
});

test('Drop-Zeit: Vorlauf, Countdown und Eintragen aus der Statistik', async () => {
  const { window, $, tick, errors } = await loadUi();
  try {
    // Ziel mit Drop-Zeit in 2 Stunden und 10 Minuten Vorlauf
    const drop = new Date(Date.now() + 2 * 3600000); drop.setSeconds(0, 0);
    $('fName').value = 'Pokémon Drop'; $('fUrl').value = 'shop.de/pkmn';
    const local = new Date(drop.getTime() - drop.getTimezoneOffset() * 60000).toISOString().slice(0, 16); // Wert für datetime-local
    $('fStart').value = local; $('fLead').value = '10';
    $('addTarget').click(); await tick();
    assert.match($('targetList').innerHTML, /⏰ Drop/);
    assert.match($('targetList').innerHTML, /Start 10 Min\. vorher/);
    assert.equal($('dropBar').classList.contains('hidden'), false);
    assert.match($('dropText').textContent, /Pokémon Drop – Drop in/);
    assert.match($('dropClock').textContent, /^0[12]:\d\d:\d\d$/);
    assert.match($('dropSub').textContent, /Fox Queue startet in 01:\d\d:\d\d/);

    // Bearbeiten zeigt Drop-Zeit und Vorlauf wieder an
    $('targetList').querySelector('button[data-act="edit"]').click(); await tick();
    assert.equal($('fLead').value, '10');
    assert.equal($('fStart').value, local);
    $('cancelEdit').click(); await tick();

    // Statistik: Vorschau-Daten haben Drops für Ziel „a“ → Zeitfenster, Eintragen setzt die Drop-Zeit
    window.document.querySelector('.nav-item[data-page="stats"]').click(); await tick();
    assert.ok($('slotList').querySelectorAll('.slot').length >= 1);
    assert.equal($('slotList').querySelectorAll('button').length, 0, 'ohne gewähltes Ziel kein Knopf');
    $('statTarget').value = 'a'; $('statTarget').dispatchEvent(new window.Event('change')); await tick();
    const btn = $('slotList').querySelector('button[data-slot]');
    assert.ok(btn, 'mit gewähltem Ziel gibt es den Knopf');
    const when = Number(btn.dataset.slot);
    assert.ok(when > Date.now());
    btn.click(); await tick();
    assert.match($('slotHint').textContent, /Drop-Zeit für „Pokémon Drop“ eingetragen/);
    assert.deepEqual(errors, []);
  } finally {
    window.close();
  }
});

test('Typische Drop-Zeiten: häufigstes Zeitfenster zuerst, nächster Termin liegt in der Zukunft', async () => {
  const { window } = await loadUi();
  try {
    const topSlots = window.eval('topSlots'), nextOccurrence = window.eval('nextOccurrence'), countdown = window.eval('countdown');
    const at = (y, m, d, h) => ({ t: new Date(y, m - 1, d, h, 15).getTime() });
    // 3x Freitag 10 Uhr, 1x Montag 18 Uhr
    const slots = topSlots([at(2026, 11, 6, 10), at(2026, 11, 13, 10), at(2026, 11, 9, 18), at(2026, 10, 30, 10)]);
    assert.deepEqual([slots[0].day, slots[0].hour, slots[0].n], [4, 10, 3]);
    assert.deepEqual([slots[1].day, slots[1].hour, slots[1].n], [0, 18, 1]);

    const mon = new Date(2026, 10, 16, 8, 0).getTime();           // Montag, 16.11.2026, 08:00
    assert.equal(new Date(nextOccurrence(4, 10, mon)).toString(), new Date(2026, 10, 20, 10, 0).toString());  // Freitag derselben Woche
    assert.equal(new Date(nextOccurrence(0, 18, mon)).toString(), new Date(2026, 10, 16, 18, 0).toString());  // heute Abend
    assert.equal(new Date(nextOccurrence(0, 7, mon)).toString(), new Date(2026, 10, 23, 7, 0).toString());    // schon vorbei → nächste Woche

    assert.equal(countdown(3872000), '01:04:32');
    assert.equal(countdown(3 * 86400000 + 4 * 3600000), '3 Tagen 4 Std.');
  } finally {
    window.close();
  }
});
