const test = require('node:test');
const assert = require('node:assert/strict');
const { isQueueHost, effInterval } = require('../desktop/queue');

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
