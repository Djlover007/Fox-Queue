// Fox Queue – erkennt, ob auf der Seite gerade ein Captcha zu sehen ist.
// Wird von Android (TaskActivity) und Windows (Zielfenster) alle paar Sekunden in die Seite
// eingespielt und liefert true/false. Es wird nichts gelöst oder angeklickt – nur gemeldet,
// damit du es selbst lösen kannst.
(() => {
  try {
    const sel = [
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="captcha" i]', 'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]',
      '.g-recaptcha', '.h-captcha', '.cf-turnstile', '#challenge-form', '#cf-challenge-running',
      '[class*="geetest"]', '[id*="captcha" i]', '[class*="captcha" i]',
    ].join(',');
    const visible = (el) => {
      if (el.closest('.grecaptcha-badge')) return false;            // unsichtbares reCAPTCHA v3 (nur Logo)
      if (el.tagName === 'IFRAME' && /size=invisible/.test(el.src)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 30 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    for (const el of document.querySelectorAll(sel)) if (visible(el)) return true;
    // Cloudflare-Prüfseite („Just a moment…“ / „Einen Moment…“)
    if (/just a moment|einen moment|attention required|captcha/i.test(document.title)) return true;
    return false;
  } catch (e) {
    return false;
  }
})()
