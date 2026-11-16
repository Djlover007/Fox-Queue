const test = require('node:test');
const assert = require('node:assert/strict');
const { isQueueHost, effInterval, backoffMs, retryAfterSec } = require('../desktop/queue');

test('Queue-Adressen werden erkannt', () => {
  assert.equal(isQueueHost('https://eventim.queue-it.net/?c=eventim&e=fob'), true);
  assert.equal(isQueueHost('https://queue-it.net/'), true);
  assert.equal(isQueueHost('https://queue.shop.de/warten'), true);
  assert.equal(isQueueHost('https://warteraum.shop.de/'), true);
});

test('normale Adressen sind keine Warteschlange', () => {
  assert.equal(isQueueHost('https://www.eventim.de/artist/fall-out-boy/'), false);
  assert.equal(isQueueHost('https://shop.de/queue'), false);
  assert.equal(isQueueHost('https://notqueue-it.net.evil.de/'), false);
  assert.equal(isQueueHost('kein link'), false);
});

test('Prüfintervall: eigenes Intervall vor Standard, nie unter 20 s', () => {
  assert.equal(effInterval({ intervalSec: 0 }, 60), 60);
  assert.equal(effInterval({}, 60), 60);
  assert.equal(effInterval({ intervalSec: 30 }, 60), 30);
  assert.equal(effInterval({ intervalSec: 5 }, 60), 20);
  assert.equal(effInterval({ intervalSec: 0 }, 5), 20);
});

test('429-Pause: 5, 10, 20, 40, dann höchstens 60 Minuten', () => {
  const min = (l, r) => backoffMs(l, r) / 60000;
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(l => min(l, 0)), [5, 10, 20, 40, 60, 60]);
  assert.equal(min(0, 0), 5);
});

test('429-Pause: längere Wartezeit des Shops gilt, höchstens 2 Stunden', () => {
  assert.equal(backoffMs(1, 60), 5 * 60000);          // Shop sagt 1 Minute → trotzdem 5
  assert.equal(backoffMs(1, 1800), 30 * 60000);       // Shop sagt 30 Minuten → 30
  assert.equal(backoffMs(1, 999999), 120 * 60000);    // Unsinnig lang → 2 Stunden
});

test('Retry-After: Sekunden und Datum werden gelesen', () => {
  assert.equal(retryAfterSec('120'), 120);
  assert.equal(retryAfterSec(null), 0);
  assert.equal(retryAfterSec('quatsch'), 0);
  const now = Date.parse('2026-11-16T15:00:00Z');
  assert.equal(retryAfterSec('Mon, 16 Nov 2026 15:10:00 GMT', now), 600);
  assert.equal(retryAfterSec('Mon, 16 Nov 2026 14:00:00 GMT', now), 0);
});
