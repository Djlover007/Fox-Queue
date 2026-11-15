# 🦊 Fox Queue

Drop- und Queue-Monitor für **Windows** und **Android**. Fox Queue beobachtet Shop- oder Ticketseiten und schlägt Alarm, sobald
- eine **Queue-it-Warteschlange** aufgeht,
- ein **Text erscheint** (z. B. „In den Warenkorb“),
- ein **Text verschwindet** (z. B. „Ausverkauft“) oder
- sich die **Seite ändert**.

Alarm gibt es als Benachrichtigung auf dem Gerät (antippen öffnet die Seite) und optional per **Discord-Webhook**.
Danach stellst du dich ganz normal mit deinem eigenen Browser an. Fox Queue nutzt keine Proxies, löst keine Captchas und drängelt nicht vor.

## Aufbau

```
ui/        gemeinsame Oberfläche (HTML/CSS/JS), Dashboard im Dark-Look
desktop/   Windows-App (Electron): main.js, engine.js, preload.js
android/   Android-App (Kotlin): WebView + Vordergrund-Dienst
.github/   GitHub Actions: baut APK und EXE automatisch
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
- Die APK ist mit `android/app/foxqueue.keystore` signiert, damit Updates sich über die alte Version installieren lassen. Repo am besten privat halten.
- Queue-it-Erkennung: Fox Queue meldet, wenn die Shopseite auf `*.queue-it.net` weiterleitet oder einen Warteschlangen-Link enthält. Für eine Queue-it-URL selbst (wie `xyz.queue-it.net/?c=...`) nimm den Modus „Seite ändert sich“ oder „Text erscheint“.
