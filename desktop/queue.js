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

module.exports = { isQueueHost, effInterval };
