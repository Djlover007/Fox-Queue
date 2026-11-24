# 🦊 Fox Queue

Drop- und Queue-Monitor für **Windows** und **Android**. Fox Queue beobachtet Shop- oder Ticketseiten und schlägt Alarm, sobald
- eine **Queue-it-Warteschlange** aufgeht,
- ein **Text erscheint** (z. B. „In den Warenkorb“),
- ein **Text verschwindet** (z. B. „Ausverkauft“) oder
- sich die **Seite ändert**.

Alarm gibt es als Benachrichtigung auf dem Gerät (antippen öffnet die Seite) und optional per **Discord-Webhook** und **Telegram**.
Danach stellst du dich ganz normal selbst an. Fox Queue löst keine Captchas und drängelt nicht vor.

## Funktionen

- **Ziele:** pro Ziel eigenes Prüfintervall, eigener Discord-Kanal und eine **Drop-Zeit mit Vorlauf** (ein paar Minuten vorher weckt dich Fox Queue, startet den Monitor und öffnet die Fenster; oben läuft ein Countdown). Die Statistik zeigt **typische Drop-Zeiten** aus bisherigen Meldungen und trägt sie auf Wunsch als Drop-Zeit ein. Ziele lassen sich bearbeiten und unter *Einstellungen → Ziele übertragen* als Text aufs andere Gerät mitnehmen.
- **Rücksicht auf den Shop:** Antwortet eine Seite mit „HTTP 429 – zu viele Anfragen“, pausiert Fox Queue dieses Ziel von selbst (5, 10, 20, 40, höchstens 60 Minuten) und hält sich an die Wartezeit, die der Shop nennt.
- **Eigene Fenster:** eine Seite in bis zu 20 eigenen Fenstern öffnen. Das Dashboard zeigt für jedes Fenster den Status (Lädt, Warteschlange mit Platz und Wartezeit, Captcha, Durch) und kann sie zeigen oder schließen; unter Windows auch als Raster anordnen.
- **Monitor & wartende Fenster:** Pro Ziel einstellbar: Die eigenen Fenster stehen bereit, laden den Shop aber erst, wenn der Monitor anschlägt – dann alle auf einmal (leicht versetzt). Bis dahin fragt nur der Monitor beim Shop nach, nicht jedes Fenster einzeln: weniger Abrufe, weniger Sperren. Optional öffnen die Fenster eine andere Adresse als die beobachtete (z. B. Monitor auf der Übersichtsseite, Fenster auf der Produktseite). Mit **⚡ Jetzt losschicken** startest du sie von Hand, und nach einem Treffer kann der Monitor 5–60 Minuten pausieren.
- **„Du bist dran“:** Verlässt ein Fenster die Warteschlange (Queue-it, Cloudflare Waiting Room, shop-eigene Warteseiten), gibt es Alarm. Antippen holt genau dieses Fenster nach vorn.
- **Captcha-Hinweis:** Taucht in einem Fenster ein Captcha auf, meldet Fox Queue das (abschaltbar, wahlweise mit Ton). Lösen musst du es selbst.
- **Android:** Hält das System ein Fenster im Hintergrund an, lädt Fox Queue es neu bzw. meldet es.

## Aufbau

```
ui/        gemeinsame Oberfläche (HTML/CSS/JS), Dashboard im Dark-Look
desktop/   Windows-App (Electron): main.js, engine.js, preload.js
android/   Android-App (Kotlin): WebView + Vordergrund-Dienst
tests/     automatische Tests (Seiten-Erkennung, Queue-Adressen, Oberfläche) – `npm test`
.github/   GitHub Actions: testet, baut APK und EXE automatisch
```

## Auto-Update

Jeder Push auf `main` baut die Version `1.0.<Laufnummer>` und veröffentlicht APK und EXE als Release in
**Djlover007/Fox-Queue-Downloads** (öffentlich, damit die Apps ohne Login an die Updates kommen; der Code bleibt hier privat).

- **Windows (Installer):** lädt Updates im Hintergrund, installiert sie beim Beenden oder per Klick auf „Neu starten & installieren“.
- **Windows (Portable):** meldet neue Versionen und öffnet die Download-Seite.
- **Android:** meldet neue Versionen (beim Öffnen und alle 6 h im Hintergrund), „Jetzt aktualisieren“ lädt die APK und startet die Installation. Beim ersten Mal muss „Apps aus dieser Quelle installieren“ erlaubt werden.

Einmalige Einrichtung:
1. Öffentliches Repo `Fox-Queue-Downloads` anlegen (mit README, damit es nicht leer ist).
2. Fine-grained Token erstellen: GitHub → Settings → Developer settings → Fine-grained tokens → nur Repo `Fox-Queue-Downloads`, Berechtigung *Contents: Read and write*.
3. Im Repo `fox-queue` unter Settings → Secrets and variables → Actions ein Secret `DOWNLOADS_TOKEN` mit diesem Token anlegen.

## Bauen

**Automatisch (empfohlen):** Auf `main` pushen. Die fertigen Dateien liegen danach unter
https://github.com/Djlover007/Fox-Queue-Downloads/releases/latest und zusätzlich im Actions-Lauf unter *Artifacts*.

**Lokal Windows:** `npm install` und dann `npm start` (testen) oder `npm run dist` (EXE in `dist/`).

**Lokal Android:** Ordner `android/` in Android Studio öffnen → *Build → Build APK(s)*.

## Hinweise

- Das Prüfintervall ist auf mindestens 20 Sekunden begrenzt. 60 s ist für die meisten Seiten gut; zu häufige Abrufe führen zu Sperren (HTTP 403/429).
- Android: Beim ersten Start nach Benachrichtigungen fragen lassen und die Akku-Optimierung für Fox Queue ausschalten, sonst bremst das System den Monitor im Hintergrund. Solange er läuft, siehst du eine dauerhafte Meldung mit Stop-Knopf.
- Die APK wird mit einem festen Schlüssel signiert, damit Updates sich über die alte Version installieren lassen. Er liegt nicht im Repo, sondern in den Secrets `KEYSTORE_B64` (Datei base64-kodiert) und `KEYSTORE_PASSWORD` unter Settings → Secrets and variables → Actions. Der Build prüft, dass es derselbe Schlüssel ist. Sicherungskopie gut aufbewahren: ohne sie sind keine Updates mehr möglich. Für einen lokalen Build die Kopie als `android/app/foxqueue.keystore` ablegen.
- Queue-it-Erkennung: Fox Queue meldet, wenn die Shopseite auf `*.queue-it.net` weiterleitet oder einen Warteschlangen-Link enthält. Für eine Queue-it-URL selbst (wie `xyz.queue-it.net/?c=...`) nimm den Modus „Seite ändert sich“ oder „Text erscheint“.
