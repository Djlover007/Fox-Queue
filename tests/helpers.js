const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DETECT = fs.readFileSync(path.join(__dirname, '..', 'ui', 'page-detect.js'), 'utf8');

/** Spielt ui/page-detect.js in eine Testseite ein – so wie es die Fenster in der App tun. */
function detect(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  // jsdom rechnet kein Layout: alles ohne „hidden“ gilt als sichtbar und groß genug
  window.Element.prototype.getBoundingClientRect = function () {
    const hidden = this.hasAttribute('hidden') || this.closest('[hidden]');
    return { width: hidden ? 0 : 300, height: hidden ? 0 : 80 };
  };
  const res = window.eval(DETECT);
  window.close();
  return res;
}

module.exports = { detect };
