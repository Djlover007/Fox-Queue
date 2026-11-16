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
