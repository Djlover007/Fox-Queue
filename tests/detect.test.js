const test = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('./helpers');

const page = (body, title = 'Shop') => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;

test('normale Shopseite: kein Captcha, keine Warteschlange', () => {
  const r = detect(page('<h1>Fall Out Boy Tickets</h1><p>Position 3 in den Charts, noch 20 Minuten bis zum Start.</p><button>In den Warenkorb</button>'));
  assert.equal(r.captcha, false);
  assert.equal(r.queue, false);
  assert.equal(r.pos, '');
  assert.equal(r.wait, '');
});

test('Captcha: reCAPTCHA, hCaptcha, Turnstile werden erkannt', () => {
  assert.equal(detect(page('<div class="g-recaptcha"></div>')).captcha, true);
  assert.equal(detect(page('<div class="h-captcha"></div>')).captcha, true);
  assert.equal(detect(page('<div class="cf-turnstile"></div>')).captcha, true);
  assert.equal(detect(page('<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe>')).captcha, true);
});

test('Captcha: unsichtbares reCAPTCHA (nur Logo) und versteckte Elemente zählen nicht', () => {
  assert.equal(detect(page('<div class="grecaptcha-badge"><iframe src="https://www.google.com/recaptcha/api2/anchor?size=invisible"></iframe></div>')).captcha, false);
  assert.equal(detect(page('<div class="g-recaptcha" hidden></div>')).captcha, false);
});

test('Captcha: Cloudflare-Prüfseite am Titel erkannt', () => {
  assert.equal(detect(page('<p>Checking your browser</p>', 'Just a moment...')).captcha, true);
  assert.equal(detect(page('<p>Wird geprüft</p>', 'Einen Moment…')).captcha, true);
});

test('Queue-it: Platz und Wartezeit werden gelesen', () => {
  const r = detect(page(`<div id="MainPart_divProgressbar"></div>
    <span id="MainPart_lbUsersInLineAheadOfYou">1.284</span>
    <span id="MainPart_lbExpectedServiceTime">ca. 12 Minuten</span>`, 'Eventim'));
  assert.equal(r.queue, true);
  assert.equal(r.pos, '1.284');
  assert.equal(r.wait, 'ca. 12 Minuten');
});

test('Cloudflare Waiting Room: an der Überschrift erkannt, Wartezeit aus dem Text', () => {
  const r = detect(page('<h1>You are now in line.</h1><p>Your estimated wait time is 12 minutes.</p>', 'Waiting Room'));
  assert.equal(r.queue, true);
  assert.equal(r.wait, '12 minutes');
});

test('Shop-eigene Warteseite auf Deutsch: Platz aus dem Text', () => {
  const r = detect(page('<h1>Du bist in der Warteschlange</h1><p>Vor dir sind 532 Personen. Geschätzte Wartezeit: etwa 8 Minuten.</p>'));
  assert.equal(r.queue, true);
  assert.equal(r.pos, '532');
  assert.equal(r.wait, 'etwa 8 Minuten');
});

test('Warteseite ohne Zahlen: Warteschlange ja, Platz leer', () => {
  const r = detect(page('<h2>Bitte warten – du bist im Wartebereich</h2>', 'Warteraum'));
  assert.equal(r.queue, true);
  assert.equal(r.pos, '');
});
