// Erkennt an der Adresse, ob eine Seite eine Warteschlange ist:
// Queue-it (*.queue-it.net) oder eine eigene Queue-Adresse des Shops (queue.shop.de, warteraum.shop.de …).
function isQueueHost(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'queue-it.net' || h.endsWith('.queue-it.net') || /^(queue|queueing|warteraum|waitingroom|waiting-room)\./.test(h);
  } catch { return false; }
}

/** Wie oft ein Ziel geprüft wird: eigenes Intervall, sonst das aus den Einstellungen (mind. 20 s). */
function effInterval(t, standard) {
  const n = Number(t && t.intervalSec) || 0;
  return Math.max(20, n > 0 ? n : (Number(standard) || 60));
}

/**
 * Pause nach „HTTP 429 – zu viele Anfragen“: 5, 10, 20, 40, höchstens 60 Minuten (verdoppelt sich bei jeder
 * weiteren 429 in Folge). Nennt der Shop selbst eine Wartezeit (Retry-After), gilt die längere von beiden, höchstens 2 Stunden.
 */
function backoffMs(level, retryAfterSec) {
  const own = Math.min(60, 5 * 2 ** (Math.max(1, level) - 1)) * 60000;
  const asked = Math.min(7200, Math.max(0, Number(retryAfterSec) || 0)) * 1000;
  return Math.max(own, asked);
}

/** Liest den Retry-After-Kopf: Sekunden oder ein Datum. Ergebnis in Sekunden (0 = keine Angabe). */
function retryAfterSec(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\s*\d+\s*$/.test(value)) return parseInt(value, 10);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 1000)) : 0;
}

module.exports = { isQueueHost, effInterval, backoffMs, retryAfterSec };
