// Fox Queue – Überwachungslogik (Windows/Electron)
// Ruft jede Seite ganz normal ab und meldet Zustandswechsel. Keine Proxies, kein Captcha-Lösen.
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 FoxQueue/1.0';

function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isQueueItUrl(u) {
  try { return /(^|\.)queue-it\.net$/i.test(new URL(u).hostname); } catch { return false; }
}

async function checkTarget(t) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res, html;
  try {
    res = await fetch(t.url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8', 'Cache-Control': 'no-cache' },
    });
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const redirectedToQueue = isQueueItUrl(res.url) && !isQueueItUrl(t.url);
  if (!res.ok && !redirectedToQueue) {
    const hint = res.status === 403 || res.status === 429 ? ' – Seite blockiert automatische Abrufe, Intervall erhöhen' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }

  const text = pageText(html);
  switch (t.mode) {
    case 'queue': {
      const queueLink = /https?:\/\/[a-z0-9-]+\.queue-it\.net\/\?c=/i.test(html);
      const live = redirectedToQueue || (!isQueueItUrl(t.url) && queueLink);
      return { live, status: live ? 'Queue aktiv' : 'Keine Queue' };
    }
    case 'keyword': {
      const live = text.toLowerCase().includes(t.keyword.toLowerCase());
      return { live, status: live ? 'Text gefunden' : 'Text fehlt' };
    }
    case 'gone': {
      const live = !text.toLowerCase().includes(t.keyword.toLowerCase());
      return { live, status: live ? 'Text weg' : 'Text noch da' };
    }
    case 'change':
    default: {
      const hash = crypto.createHash('sha1').update(text).digest('hex');
      return { hash, status: 'Beobachtet' };
    }
  }
}

module.exports = { checkTarget };
