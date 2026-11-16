// Fox Queue – schaut sich die Seite in einem eigenen Fenster an und meldet:
//   captcha: ist ein Captcha zu sehen?      queue: steht die Seite in einer Warteschlange?
//   pos / wait: Platz und Wartezeit, soweit die Seite sie anzeigt.
// Wird von Android (TaskActivity) und Windows (Zielfenster) alle 2 Sekunden in die Seite eingespielt.
// Es wird nichts gelöst, angeklickt oder verändert – nur gelesen.
(() => {
  const out = { captcha: false, queue: false, pos: '', wait: '', ready: false };
  try {
    out.ready = document.readyState === 'complete';
    const txt = (el) => (el && el.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 30 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };

    // ---- Captcha ----
    const capSel = [
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="captcha" i]', 'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]',
      '.g-recaptcha', '.h-captcha', '.cf-turnstile', '#challenge-form', '#cf-challenge-running',
      '[class*="geetest"]', '[id*="captcha" i]', '[class*="captcha" i]',
    ].join(',');
    for (const el of document.querySelectorAll(capSel)) {
      if (el.closest('.grecaptcha-badge')) continue;                         // unsichtbares reCAPTCHA v3 (nur Logo)
      if (el.tagName === 'IFRAME' && /size=invisible/.test(el.src)) continue;
      if (visible(el)) { out.captcha = true; break; }
    }
    // Cloudflare-Prüfseite („Just a moment…“ / „Einen Moment…“)
    if (!out.captcha && /just a moment|einen moment|attention required|captcha/i.test(document.title)) out.captcha = true;

    // ---- Warteschlange ----
    // Queue-it (auch wenn sie unter der Adresse des Shops läuft)
    const qPos = document.querySelector('#MainPart_lbUsersInLineAheadOfYou, #MainPart_lbQueueNumber');
    const qWait = document.querySelector('#MainPart_lbExpectedServiceTime, #MainPart_lbWhichIsIn');
    const queueIt = !!(qPos || qWait || document.querySelector('#MainPart_divProgressbar, [data-pageid="queue"], [data-pageid="before"]'));
    // Cloudflare Waiting Room und shop-eigene Warteseiten: an Titel und Überschriften erkannt
    const PHRASE = /waiting room|warteraum|virtuelle[rn]? warte|you are (now )?in (the )?(line|queue)|in der warteschlange|im wartebereich|du bist gleich dran|sie sind gleich dran/i;
    let phrase = /waiting room|warteraum|warteschlange|virtual queue|you are (now )?in line/i.test(document.title);
    if (!phrase) for (const h of document.querySelectorAll('h1, h2')) if (PHRASE.test(txt(h))) { phrase = true; break; }
    out.queue = queueIt || phrase;

    if (out.queue) {
      const body = txt(document.body).slice(0, 6000);
      const num = (s) => { const m = /\d[\d.,\s]*\d|\d/.exec(s || ''); return m ? m[0].replace(/\s/g, '') : ''; };
      out.pos = num(txt(qPos));
      if (!out.pos) {
        const m = /(\d[\d.,]*)\s*(personen|nutzer|besucher|kunden|leute|users|people|visitors)\s*(sind\s*)?(vor|ahead)/i.exec(body)
          || /(?:vor (?:dir|ihnen)|ahead of you)\D{0,30}?(\d[\d.,]*)/i.exec(body)
          || /(?:platz|position|nummer|number)\D{0,25}?(\d[\d.,]*)/i.exec(body);
        if (m) out.pos = m[1].replace(/[.,]$/, '');
      }
      out.wait = txt(qWait).slice(0, 40);
      if (!out.wait) {
        const m = /((?:weniger als|mehr als|less than|more than|ca\.?|etwa|about)\s*)?\d+\s*(minuten|minutes|minute|min\b|stunden|stunde|hours|hour)/i.exec(body);
        if (m) out.wait = m[0];
      }
    }
  } catch (e) { /* Seite lässt sich gerade nicht lesen */ }
  return out;
})()
