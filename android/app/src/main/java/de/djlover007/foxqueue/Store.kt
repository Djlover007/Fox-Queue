package de.djlover007.foxqueue

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Notification
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URL
import java.security.MessageDigest

/** Zentraler Zustand + Überwachungslogik. Keine Proxies, kein Captcha-Lösen – nur normale Abrufe. */
object Store {
    const val CH_ALERT = "fox_alert2"  // v2: ohne Kanal-Vibration, die steuert die App selbst
    const val CH_SERVICE = "fox_service"
    const val CH_CAPTCHA = "fox_captcha"
    private const val UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 FoxQueue/1.0"

    data class Target(
        val id: String, var name: String, var url: String, var mode: String, var keyword: String, var enabled: Boolean,
        var webhook: String = "",
        var intervalSec: Int = 0,   // eigenes Prüfintervall, 0 = Standard aus den Einstellungen
        var startAt: Long = 0,      // Startzeit (ms), 0 = keine
        var dropAt: Long = 0,       // Drop-Zeit (ms) für Anzeige und Countdown; startAt liegt um den Vorlauf davor
        var windows: Int = 1,       // so viele eigene Fenster öffnet „Eigene Fenster öffnen“ / die Startzeit
        var status: String = "Wartet", var live: Boolean = false, var lastCheck: Long = 0, var lastError: String = "", var hash: String? = null,
        var backoff: Int = 0,       // wie oft in Folge „HTTP 429“ kam
        var pauseUntil: Long = 0,   // bis dahin wird das Ziel nicht geprüft (Shop bremst)
    )

    /** Abruf mit Fehlercode beantwortet; retryAfter = vom Shop genannte Wartezeit in Sekunden (0 = keine). */
    private class HttpError(val code: Int, val retryAfter: Long, msg: String) : Exception(msg)

    /** Pause nach HTTP 429: 5, 10, 20, 40, höchstens 60 Minuten; nennt der Shop eine längere Wartezeit, gilt die (höchstens 2 Stunden). */
    private fun backoffMs(level: Int, retryAfterSec: Long): Long {
        val own = minOf(60L, 5L shl (maxOf(1, level) - 1).coerceAtMost(6)) * 60_000L
        val asked = retryAfterSec.coerceIn(0L, 7200L) * 1000L
        return maxOf(own, asked)
    }

    private fun retryAfterSec(v: String?): Long {
        if (v.isNullOrBlank()) return 0L
        v.trim().toLongOrNull()?.let { return it }
        return try {
            val t = java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US).parse(v.trim())?.time ?: return 0L
            maxOf(0L, (t - System.currentTimeMillis()) / 1000)
        } catch (_: Exception) { 0L }
    }

    @Volatile var running = false
    var intervalSec = 60
    var webhook = ""
    var notify = true
    var sound = true
    var vibrate = true
    var openBrowser = false
    var captchaNotify = true    // Hinweis, wenn in einem eigenen Fenster ein Captcha auftaucht
    var captchaSound = false    // … zusätzlich mit lautem Alarmton
    var captchaFront = true     // … und das Fenster von selbst nach vorn holen (wenn das Dashboard offen ist)
    var tgToken = ""            // Telegram: Bot-Token
    var tgChat = ""             // Telegram: Chat-ID
    const val MAX_WINDOWS = 20
    @Volatile var foreground = false   // App gerade sichtbar?
    var proxy = ""   // optionaler einzelner Proxy: http://[nutzer:pass@]host:port
    @Volatile private var client: OkHttpClient = OkHttpClient()
    private val events = ArrayList<JSONObject>()  // Drop-Statistik
    @Volatile var ringing: JSONObject? = null
    private var player: MediaPlayer? = null
    private val main = Handler(Looper.getMainLooper())
    private val autoStop = Runnable { stopAlarm() }
    val targets = mutableListOf<Target>()
    var alerts = 0; var errors = 0; var checks = 0
    private val log = ArrayList<JSONObject>()
    private var loaded = false
    lateinit var appCtx: Context
    private var alertId = 1000

    // ---------- Speicher ----------
    @Synchronized fun load(ctx: Context) {
        if (loaded) return
        loaded = true
        appCtx = ctx.applicationContext
        createChannels(ctx)
        val p = ctx.getSharedPreferences("fox", Context.MODE_PRIVATE)
        intervalSec = p.getInt("interval", 60)
        webhook = p.getString("webhook", "") ?: ""
        notify = p.getBoolean("notify", true)
        sound = p.getBoolean("sound", true)
        vibrate = p.getBoolean("vibrate", true)
        openBrowser = p.getBoolean("openBrowser", false)
        captchaNotify = p.getBoolean("captchaNotify", true)
        captchaSound = p.getBoolean("captchaSound", false)
        captchaFront = p.getBoolean("captchaFront", true)
        tgToken = p.getString("tgToken", "") ?: ""
        tgChat = p.getString("tgChat", "") ?: ""
        applyProxy(p.getString("proxy", "") ?: "")
        val ev = JSONArray(p.getString("events", "[]"))
        for (i in 0 until ev.length()) events.add(ev.getJSONObject(i))
        val arr = JSONArray(p.getString("targets", "[]"))
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            targets.add(Target(o.getString("id"), o.getString("name"), o.getString("url"), o.getString("mode"), o.optString("keyword"), o.optBoolean("enabled", true), o.optString("webhook"),
                o.optInt("intervalSec", 0), o.optLong("startAt", 0), o.optLong("dropAt", 0), o.optInt("windows", 1).coerceIn(1, MAX_WINDOWS)))
        }
        scheduleStarts(ctx)
    }

    @Synchronized fun save(ctx: Context) {
        val arr = JSONArray()
        targets.forEach {
            arr.put(JSONObject().put("id", it.id).put("name", it.name).put("url", it.url).put("mode", it.mode).put("keyword", it.keyword).put("enabled", it.enabled).put("webhook", it.webhook)
                .put("intervalSec", it.intervalSec).put("startAt", it.startAt).put("dropAt", it.dropAt).put("windows", it.windows))
        }
        ctx.getSharedPreferences("fox", Context.MODE_PRIVATE).edit()
            .putInt("interval", intervalSec).putString("webhook", webhook).putBoolean("notify", notify).putBoolean("sound", sound).putBoolean("vibrate", vibrate).putBoolean("openBrowser", openBrowser).putString("proxy", proxy)
            .putBoolean("captchaNotify", captchaNotify).putBoolean("captchaSound", captchaSound).putBoolean("captchaFront", captchaFront).putString("tgToken", tgToken).putString("tgChat", tgChat)
            .putString("targets", arr.toString()).putString("events", JSONArray(events).toString()).apply()
    }

    @Synchronized fun log(type: String, msg: String) {
        log.add(0, JSONObject().put("t", System.currentTimeMillis()).put("type", type).put("msg", msg))
        while (log.size > 300) log.removeAt(log.size - 1)
    }

    @Synchronized fun clearLog() = log.clear()

    @Synchronized fun clearStats(ctx: Context) { events.clear(); save(ctx) }

    @Synchronized fun stateJson(): String {
        val ts = JSONArray()
        targets.forEach {
            ts.put(JSONObject().put("id", it.id).put("name", it.name).put("url", it.url).put("mode", it.mode).put("keyword", it.keyword)
                .put("enabled", it.enabled).put("webhook", it.webhook).put("intervalSec", it.intervalSec).put("startAt", it.startAt).put("dropAt", it.dropAt).put("windows", it.windows).put("status", it.status).put("live", it.live).put("lastCheck", it.lastCheck).put("lastError", it.lastError).put("pauseUntil", it.pauseUntil))
        }
        val ws = JSONArray()
        windows.values.sortedBy { it.id }.forEach {
            ws.put(JSONObject().put("id", it.id).put("title", it.title).put("url", it.url).put("status", it.status).put("pos", it.pos).put("wait", it.wait))
        }
        return JSONObject()
            .put("running", running).put("platform", "android").put("windows", ws)
            .put("config", JSONObject().put("intervalSec", intervalSec).put("webhook", webhook).put("notify", notify).put("openBrowser", openBrowser).put("sound", sound).put("vibrate", vibrate).put("proxy", proxy)
                .put("captchaNotify", captchaNotify).put("captchaSound", captchaSound).put("captchaFront", captchaFront).put("tgToken", tgToken).put("tgChat", tgChat))
            .put("events", JSONArray(events))
            .put("ringing", ringing ?: JSONObject.NULL)
            .put("targets", ts)
            .put("stats", JSONObject().put("alerts", alerts).put("errors", errors).put("checks", checks))
            .put("log", JSONArray(log))
            .put("version", Updater.current(appCtx))
            .put("update", Updater.json(appCtx))
            .toString()
    }

    @Synchronized fun resetRun() {
        alerts = 0; errors = 0; checks = 0
        targets.forEach { it.live = false; it.hash = null; it.lastError = ""; it.lastCheck = 0 }
    }

    // ---------- Proxy ----------
    @Synchronized fun applyProxy(value: String) {
        proxy = value.trim()
        var p: Proxy = Proxy.NO_PROXY
        var auth: String? = null
        if (proxy.isNotEmpty()) try {
            val u = URI(proxy)
            val host = u.host ?: throw Exception("kein Host")
            val port = if (u.port > 0) u.port else 8080
            p = Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved(host, port))
            val info = u.rawUserInfo
            if (!info.isNullOrEmpty()) {
                auth = Credentials.basic(Uri.decode(info.substringBefore(':')), Uri.decode(info.substringAfter(':', "")))
            }
        } catch (e: Exception) {
            p = Proxy.NO_PROXY; auth = null
            log("error", "Proxy ungültig: ${e.message}")
        }
        val cred = auth
        // OkHttp schickt die Proxy-Anmeldung gleich beim Verbindungsaufbau mit (auch für HTTPS/CONNECT)
        client = OkHttpClient.Builder()
            .proxy(p)
            .proxyAuthenticator { _, response ->
                if (cred == null || response.request.header("Proxy-Authorization") != null) null
                else response.request.newBuilder().header("Proxy-Authorization", cred).build()
            }
            .followRedirects(true).followSslRedirects(true)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(40, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    // ---------- Abruf ----------
    /** Wie oft ein Ziel geprüft wird: eigenes Intervall, sonst das aus den Einstellungen (mind. 20 s). */
    fun effInterval(t: Target) = maxOf(20, if (t.intervalSec > 0) t.intervalSec else intervalSec)

    /** Takt des Monitors = kürzestes Intervall aller aktiven Ziele. */
    @Synchronized fun tickSec(): Int = targets.filter { it.enabled }.minOfOrNull { effInterval(it) }?.let { minOf(it, intervalSec) } ?: intervalSec

    private fun isQueueIt(u: String) = try { URL(u).host.lowercase().let { it == "queue-it.net" || it.endsWith(".queue-it.net") } } catch (e: Exception) { false }

    private fun pageText(html: String) = html
        .replace(Regex("(?is)<script.*?</script>"), " ")
        .replace(Regex("(?is)<style.*?</style>"), " ")
        .replace(Regex("<[^>]+>"), " ")
        .replace("&nbsp;", " ").replace("&amp;", "&")
        .replace(Regex("\\s+"), " ").trim()

    private fun netError(e: Exception): String = when (e) {
        is java.net.UnknownHostException -> "Seite nicht gefunden (Adresse prüfen)"
        is java.net.SocketTimeoutException -> "Zeitüberschreitung"
        else -> e.message ?: e.javaClass.simpleName
    }

    private fun proxyError(e: Exception): String {
        val m = e.message ?: e.javaClass.simpleName
        return when {
            m.contains("407") || m.contains("authenticat", true) -> "Proxy hat die Verbindung abgelehnt (Benutzer/Passwort prüfen)"
            m.contains("end of stream", true) -> "Proxy hat die Verbindung ohne Antwort beendet (Typ/Port prüfen – nur HTTP-Proxys)"
            e is java.net.ConnectException || e is java.net.UnknownHostException -> "Proxy nicht erreichbar"
            e is java.net.SocketTimeoutException -> "Proxy antwortet nicht (Zeitüberschreitung)"
            else -> "Proxy-Fehler: $m"
        }
    }

    private class Result(val live: Boolean, val status: String, val hash: String? = null)

    private fun fetch(t: Target): Result {
        val req = Request.Builder().url(t.url)
            .header("User-Agent", UA)
            .header("Accept-Language", "de-DE,de;q=0.9,en;q=0.8")
            .header("Cache-Control", "no-cache")
            .build()
        val resp = try { client.newCall(req).execute() } catch (e: java.io.IOException) {
            throw Exception(if (proxy.isNotEmpty()) proxyError(e) else netError(e))
        }
        val html: String
        val finalUrl: String
        try {
            val code = resp.code
            finalUrl = resp.request.url.toString()
            if (code == 407) throw Exception("Proxy hat die Verbindung abgelehnt (Benutzer/Passwort prüfen)")
            val redirected = isQueueIt(finalUrl) && !isQueueIt(t.url)
            if (code >= 400 && !redirected) {
                val hint = if (code == 429) " – Shop bremst automatische Abrufe" else if (code == 403) " – Seite blockiert automatische Abrufe" else ""
                throw HttpError(code, retryAfterSec(resp.header("Retry-After")), "HTTP $code$hint")
            }
            val bytes = resp.body?.bytes() ?: ByteArray(0)
            html = String(bytes, 0, minOf(bytes.size, 3_000_000), Charsets.UTF_8)
        } finally {
            resp.close()
        }
        val url = finalUrl
        val redirectedToQueue = isQueueIt(url) && !isQueueIt(t.url)

        val text = pageText(html)
        return when (t.mode) {
            "queue" -> {
                val link = Regex("(?i)https?://[a-z0-9-]+\\.queue-it\\.net/\\?c=").containsMatchIn(html)
                val live = redirectedToQueue || (!isQueueIt(t.url) && link)
                Result(live, if (live) "Queue aktiv" else "Keine Queue")
            }
            "keyword" -> { val live = text.contains(t.keyword, true); Result(live, if (live) "Text gefunden" else "Text fehlt") }
            "gone" -> { val live = !text.contains(t.keyword, true); Result(live, if (live) "Text weg" else "Text noch da") }
            else -> {
                val h = MessageDigest.getInstance("SHA-1").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
                Result(false, "Beobachtet", h)
            }
        }
    }

    /** Eine Runde über alle aktiven Ziele. Läuft im Hintergrund-Thread des Dienstes. */
    private const val PARALLEL = 4

    /** Bis zu 4 Ziele gleichzeitig prüfen – jedes Ziel trotzdem nur einmal pro Intervall. */
    fun runRound(ctx: Context) {
        // Nur Ziele, deren (eigenes) Intervall abgelaufen ist
        val now = System.currentTimeMillis()
        val list = synchronized(this) { targets.filter { it.enabled && it.pauseUntil <= now && now - it.lastCheck >= effInterval(it) * 1000L - 1500 } }
        if (list.isEmpty()) return
        val pool = java.util.concurrent.Executors.newFixedThreadPool(minOf(PARALLEL, list.size))
        try {
            val jobs = list.map { t ->
                pool.submit {
                    Thread.sleep((Math.random() * 300).toLong())
                    if (running) checkOne(ctx, t)
                }
            }
            for (j in jobs) {
                try { j.get() }
                catch (e: InterruptedException) { Thread.currentThread().interrupt(); return }  // Monitor gestoppt
                catch (_: Exception) { }
            }
        } finally {
            pool.shutdownNow()
        }
    }

    private fun checkOne(ctx: Context, t: Target) {
            try {
                val r = fetch(t)
                synchronized(this) {
                    checks++
                    t.lastCheck = System.currentTimeMillis()
                    if (t.lastError.isNotEmpty()) log("info", "${t.name}: wieder erreichbar")
                    t.lastError = ""; t.backoff = 0; t.pauseUntil = 0
                    t.status = r.status
                }
                if (t.mode == "change") {
                    val changed = t.hash != null && r.hash != t.hash
                    t.hash = r.hash
                    t.live = changed
                    if (changed) alarm(ctx, t, "Seite hat sich geändert", "Der Inhalt ist anders als beim letzten Abruf.")
                } else {
                    val was = t.live
                    t.live = r.live
                    if (r.live && !was) {
                        val title = when (t.mode) { "queue" -> "Warteschlange ist offen"; "keyword" -> "Text ist aufgetaucht"; else -> "Text ist verschwunden" }
                        alarm(ctx, t, title, "Jetzt selbst im Browser anstellen.")
                    } else if (!r.live && was) log("info", "${t.name}: ${r.status}")
                }
            } catch (e: Exception) {
                var msg = if (e is java.net.SocketTimeoutException) "Zeitüberschreitung" else (e.message ?: e.javaClass.simpleName)
                synchronized(this) {
                    if (e is HttpError && e.code == 429) {
                        // Shop bremst: Ziel pausieren, bei jeder weiteren 429 doppelt so lang
                        t.backoff++
                        t.pauseUntil = System.currentTimeMillis() + backoffMs(t.backoff, e.retryAfter)
                        msg += ". Pause bis " + java.text.SimpleDateFormat("HH:mm", java.util.Locale.GERMANY).format(java.util.Date(t.pauseUntil)) + " Uhr" +
                            (if (t.backoff >= 3) " – am besten das Prüfintervall für dieses Ziel erhöhen" else "")
                    }
                    errors++
                    t.lastCheck = System.currentTimeMillis()
                    if (t.lastError != msg) log("error", "${t.name}: $msg")
                    t.lastError = msg
                }
            }
    }

    // ---------- Alarm ----------
    fun alarm(ctx: Context, t: Target, title: String, body: String, count: Boolean = true) {
        synchronized(this) {
            if (count) {
                alerts++
                events.add(JSONObject().put("t", System.currentTimeMillis()).put("targetId", t.id).put("name", t.name).put("mode", t.mode))
                while (events.size > 1000) events.removeAt(0)
                save(ctx)
            }
            log("alert", "🦊 $title: ${t.name}")
        }
        if (sound) startAlarm(ctx, t, title)
        else if (vibrate) try {
            // Ohne Ton: einmal kurz vibrieren
            ctx.getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 500, 250, 500), -1))
        } catch (_: Exception) { }
        // Seite automatisch öffnen: sofort, wenn die App offen ist – sonst per Vollbild-Benachrichtigung
        var autoOpen: PendingIntent? = null
        if (openBrowser) {
            if (foreground) main.post {
                try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(t.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { }
            } else autoOpen = PendingIntent.getActivity(
                ctx, alertId + 50_000,
                Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_AUTO_OPEN).putExtra("url", t.url)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        if (notify || sound || autoOpen != null) {
            // Antippen: App öffnet die Seite und stoppt den Alarm
            val open = PendingIntent.getActivity(
                ctx, alertId,
                Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_ALERT).putExtra("url", t.url)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val silence = PendingIntent.getBroadcast(
                ctx, 5, Intent(ctx, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_STOP_ALARM),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val n = Notification.Builder(ctx, CH_ALERT)
                .setSmallIcon(R.drawable.ic_stat_fox)
                .setContentTitle("🦊 $title")
                .setContentText("${t.name} – antippen zum Öffnen")
                .setStyle(Notification.BigTextStyle().bigText("${t.name}\n$body\n${t.url}"))
                .setContentIntent(open)
                .setDeleteIntent(silence)
                .apply { autoOpen?.let { setFullScreenIntent(it, true) } }
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .apply {
                    if (sound) addAction(Notification.Action.Builder(
                        android.graphics.drawable.Icon.createWithResource(ctx, R.drawable.ic_stat_fox), "Alarm aus", silence).build())
                }
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(alertId++, n)
        }
        remote(t.webhook.ifBlank { webhook }, title, t.name, body, t.url)
    }

    /** Store bereit machen, falls ein Fenster nach einem Neustart des Prozesses zuerst aufgeht. */
    fun ensureLoaded(ctx: Context) { if (!::appCtx.isInitialized) load(ctx) }

    // ---------- Captcha-Hinweis aus einem eigenen Fenster ----------
    /** Meldet ein Captcha: Benachrichtigung (antippen holt genau dieses Fenster nach vorn) + Discord. */
    fun captchaFound(ctx: Context, name: String, url: String, taskId: Int) {
        if (!captchaNotify) return
        log("alert", "🧩 Captcha wartet: $name")
        if (captchaSound) { startAlarm(ctx, Target("task$taskId", name, url, "queue", "", true), "Captcha wartet"); ringingTask = taskId }
        val focus = PendingIntent.getActivity(
            ctx, 70_000 + taskId,
            Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_FOCUS_TASK).putExtra("taskId", taskId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(ctx, CH_CAPTCHA)
            .setSmallIcon(R.drawable.ic_stat_fox)
            .setContentTitle("🧩 Captcha: $name")
            .setContentText("Antippen und selbst lösen")
            .setContentIntent(focus)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(80_000 + taskId, n)
        val hook = hookFor(url)
        Thread { remote(hook, "Captcha wartet", name, "In einem Fox-Queue-Fenster ist ein Captcha aufgetaucht – bitte selbst lösen.", url) }.start()
    }

    // ---------- „Du bist dran“: Warteschlange in einem eigenen Fenster durch ----------
    /** Welches Fenster gerade klingelt (-1 = keins). Öffnest du dieses Fenster, geht der Ton aus. */
    @Volatile var ringingTask = -1

    fun queuePassed(ctx: Context, name: String, url: String, taskId: Int, looking: Boolean) {
        synchronized(this) {
            alerts++
            events.add(JSONObject().put("t", System.currentTimeMillis()).put("targetId", "task").put("name", name).put("mode", "queue"))
            while (events.size > 1000) events.removeAt(0)
            save(ctx)
            log("alert", "🎉 Du bist dran: $name")
        }
        if (looking) {
            // Du schaust gerade auf genau dieses Fenster: nur kurz vibrieren statt Alarm
            try { ctx.getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 400, 200, 400), -1)) } catch (_: Exception) { }
        } else {
            val t = Target("task$taskId", name, url, "queue", "", true)
            if (sound) { startAlarm(ctx, t, "Du bist dran"); ringingTask = taskId }
            else if (vibrate) try {
                ctx.getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 500, 250, 500), -1))
            } catch (_: Exception) { }
            val focus = PendingIntent.getActivity(
                ctx, 90_000 + taskId,
                Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_FOCUS_TASK).putExtra("taskId", taskId)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val silence = PendingIntent.getBroadcast(
                ctx, 5, Intent(ctx, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_STOP_ALARM),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val n = Notification.Builder(ctx, CH_ALERT)
                .setSmallIcon(R.drawable.ic_stat_fox)
                .setContentTitle("🎉 Du bist dran: $name")
                .setContentText("Warteschlange durch – antippen und schnell weitermachen")
                .setContentIntent(focus)
                .setDeleteIntent(silence)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .apply {
                    if (sound) addAction(Notification.Action.Builder(
                        android.graphics.drawable.Icon.createWithResource(ctx, R.drawable.ic_stat_fox), "Alarm aus", silence).build())
                }
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(90_000 + taskId, n)
        }
        val hook = hookFor(url)
        Thread { remote(hook, "Du bist dran", name, "Die Warteschlange ist durch – du bist im Shop.", url) }.start()
    }

    /** Hinweis entfernen, sobald das Captcha weg ist. */
    fun captchaGone(ctx: Context, taskId: Int) {
        ctx.getSystemService(NotificationManager::class.java).cancel(80_000 + taskId)
    }

    // ---------- Ton-Alarm (Wecker-Kanal: klingelt auch im Lautlos-Modus) ----------
    private fun startAlarm(ctx: Context, t: Target, title: String) {
        ringing = JSONObject().put("name", t.name).put("url", t.url).put("title", title).put("t", System.currentTimeMillis())
        main.post {
            try {
                player?.release()
                val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                player = MediaPlayer().apply {
                    setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    setDataSource(ctx, uri)
                    isLooping = true
                    prepare()
                    start()
                }
            } catch (e: Exception) {
                log("error", "Alarmton: ${e.message}")
            }
            if (vibrate) try {
                val vib = ctx.getSystemService(Vibrator::class.java)
                vib?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 400, 600, 400, 1200), 0),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
            } catch (_: Exception) { }
            main.removeCallbacks(autoStop)
            main.postDelayed(autoStop, 120_000)  // spätestens nach 2 Minuten aus
        }
    }

    fun stopAlarm() {
        ringing = null
        ringingTask = -1
        main.post {
            main.removeCallbacks(autoStop)
            try { player?.stop() } catch (_: Exception) { }
            player?.release(); player = null
            try { appCtx.getSystemService(Vibrator::class.java)?.cancel() } catch (_: Exception) { }
        }
    }

    private fun sendDiscord(hook: String, title: String, name: String, body: String, url: String) {
        try {
            val payload = JSONObject()
                .put("username", "Fox Queue")
                .put("embeds", JSONArray().put(JSONObject()
                    .put("title", "🦊 $title").put("description", "**$name**\n$body").put("url", url).put("color", 0xE8893A)))
            val c = (URL(hook).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"; doOutput = true
                connectTimeout = 10000; readTimeout = 10000
                setRequestProperty("Content-Type", "application/json")
            }
            c.outputStream.use { it.write(payload.toString().toByteArray()) }
            val code = c.responseCode
            c.disconnect()
            if (code >= 300) log("error", "Discord-Webhook: HTTP $code")
        } catch (e: Exception) {
            log("error", "Discord-Webhook: ${e.message}")
        }
    }

    private fun hookFor(url: String): String = synchronized(this) { targets.find { it.url == url }?.webhook }.orEmpty().ifBlank { webhook }

    /** Alarm an alle eingerichteten Fern-Kanäle: Discord (falls Webhook) und Telegram (falls eingerichtet). Nicht im UI-Thread aufrufen. */
    private fun remote(hook: String, title: String, name: String, body: String, url: String) {
        if (hook.isNotBlank()) sendDiscord(hook, title, name, body, url)
        sendTelegram(title, name, body, url)
    }

    private fun sendTelegram(title: String, name: String, body: String, url: String) {
        val token = tgToken; val chat = tgChat
        if (token.isBlank() || chat.isBlank()) return
        try {
            val payload = JSONObject().put("chat_id", chat).put("text", "🦊 $title\n$name\n$body\n$url").put("disable_web_page_preview", true)
            val c = (URL("https://api.telegram.org/bot$token/sendMessage").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"; doOutput = true
                connectTimeout = 10000; readTimeout = 10000
                setRequestProperty("Content-Type", "application/json")
            }
            c.outputStream.use { it.write(payload.toString().toByteArray()) }
            val code = c.responseCode
            c.disconnect()
            if (code >= 300) log("error", "Telegram: HTTP $code" + (if (code == 401) " (Bot-Token prüfen)" else if (code == 400) " (Chat-ID prüfen)" else ""))
        } catch (e: Exception) {
            log("error", "Telegram: ${e.message}")
        }
    }

    // ---------- Eigene Fenster: Übersicht fürs Dashboard ----------
    class Win(val id: Int, @Volatile var title: String, @Volatile var url: String, @Volatile var status: String = "loading", @Volatile var pos: String = "", @Volatile var wait: String = "")
    val windows = java.util.concurrent.ConcurrentHashMap<Int, Win>()

    fun reportWindow(id: Int, title: String, url: String, status: String, pos: String, wait: String) {
        val w = windows.getOrPut(id) { Win(id, title, url) }
        w.title = title; w.url = url; w.status = status; w.pos = pos; w.wait = wait
    }

    private fun taskIdOf(t: android.app.ActivityManager.AppTask): Int = try {
        if (android.os.Build.VERSION.SDK_INT >= 29) t.taskInfo.taskId else @Suppress("DEPRECATION") t.taskInfo.id
    } catch (_: Exception) { -1 }

    private fun appTask(ctx: Context, id: Int) =
        ctx.getSystemService(android.app.ActivityManager::class.java).appTasks.firstOrNull { taskIdOf(it) == id }

    /** Einträge entfernen, deren Fenster es nicht mehr gibt (z. B. in der Übersicht weggewischt). */
    fun pruneWindows(ctx: Context) {
        if (windows.isEmpty()) return
        val alive = try { ctx.getSystemService(android.app.ActivityManager::class.java).appTasks.map { taskIdOf(it) }.toSet() } catch (_: Exception) { return }
        windows.keys.filter { it !in alive }.forEach { windows.remove(it) }
    }

    fun focusWindow(ctx: Context, id: Int) { try { appTask(ctx, id)?.moveToFront() } catch (_: Exception) { } }

    fun closeWindow(ctx: Context, id: Int) {
        try { appTask(ctx, id)?.finishAndRemoveTask() } catch (_: Exception) { }
        windows.remove(id)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.cancel(80_000 + id); nm.cancel(90_000 + id); nm.cancel(95_000 + id)
        if (ringingTask == id) stopAlarm()
    }

    fun closeAllWindows(ctx: Context) { windows.keys.toList().forEach { closeWindow(ctx, it) } }

    /** Android hat ein Fenster im Hintergrund beendet: merken und melden. Beim Öffnen lädt es sich neu. */
    fun windowKilled(ctx: Context, id: Int, title: String) {
        val app = ctx.applicationContext
        // Kurz warten: Wurde das Fenster in der Übersicht weggewischt, gibt es den Task nicht mehr → kein Hinweis
        main.postDelayed({ windowKilledNow(app, id, title) }, 1500)
    }

    private fun windowKilledNow(ctx: Context, id: Int, title: String) {
        val gone = try { appTask(ctx, id) == null } catch (_: Exception) { true }
        if (gone) { windows.remove(id); return }
        val w = windows[id] ?: return
        w.status = "killed"; w.pos = ""; w.wait = ""
        log("error", "Android hat ein Fenster angehalten: $title – beim Öffnen lädt es neu")
        if (!notify) return
        val focus = PendingIntent.getActivity(
            ctx, 95_000 + id,
            Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_FOCUS_TASK).putExtra("taskId", id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(ctx, CH_CAPTCHA)
            .setSmallIcon(R.drawable.ic_stat_fox)
            .setContentTitle("⚠️ Fenster angehalten: $title")
            .setContentText("Android hat es geschlossen – antippen lädt es neu")
            .setContentIntent(focus).setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(95_000 + id, n)
    }

    // ---------- Startzeit pro Ziel ----------
    /** Stellt den Wecker auf die nächste Startzeit (oder löscht ihn). */
    fun scheduleStarts(ctx: Context) {
        try {
            val am = ctx.getSystemService(android.app.AlarmManager::class.java)
            val pi = PendingIntent.getBroadcast(
                ctx, 9, Intent(ctx, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_START_AT),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            am.cancel(pi)
            val next = synchronized(this) { targets.filter { it.startAt > 0 }.minOfOrNull { it.startAt } } ?: return
            try {
                if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, next, pi)
                else am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, next, pi)
            } catch (_: SecurityException) {
                am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, next, pi)
            }
        } catch (e: Exception) {
            log("error", "Startzeit: ${e.message}")
        }
    }

    /** Fällige Startzeiten ausführen: Monitor starten, Fenster öffnen (oder melden, wenn die App nicht offen ist). */
    fun fireDueStarts(ctx: Context) {
        val now = System.currentTimeMillis()
        // Fällige Ziele in einem Zug übernehmen, damit keine Startzeit doppelt auslöst
        val due = synchronized(this) {
            targets.filter { it.startAt > 0 && it.startAt <= now }.map { t -> Pair(t, now - t.startAt).also { t.startAt = 0 } }
        }
        if (due.isEmpty()) return
        for ((t, late) in due) {
            if (late > 10 * 60_000L) { log("error", "Startzeit verpasst: ${t.name}"); continue }
            log("alert", "⏰ Startzeit erreicht: ${t.name}")
            synchronized(this) { t.enabled = true }
            if (!running) try {
                ctx.startForegroundService(Intent(ctx, MonitorService::class.java))
                running = true
            } catch (e: Exception) { log("error", "Monitor konnte nicht starten: ${e.message}") }
            if (foreground) {
                // App ist offen: Fenster direkt öffnen
                main.post { try { TaskActivity.open(ctx, t.url, t.name, t.windows) } catch (_: Exception) { } }
            } else {
                // Aus dem Hintergrund darf Android keine Fenster öffnen → Alarm, Antippen öffnet sie
                if (sound) startAlarm(ctx, t, "Gleich geht's los")
                val open = PendingIntent.getActivity(
                    ctx, 60_000 + (t.id.hashCode() and 0xfff),
                    Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_WINDOWS).putExtra("targetId", t.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                val silence = PendingIntent.getBroadcast(
                    ctx, 5, Intent(ctx, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_STOP_ALARM),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                val n = Notification.Builder(ctx, CH_ALERT)
                    .setSmallIcon(R.drawable.ic_stat_fox)
                    .setContentTitle("⏰ Gleich geht's los: ${t.name}")
                    .setContentText((if (t.dropAt > now) "Drop um " + java.text.SimpleDateFormat("HH:mm", java.util.Locale.GERMANY).format(java.util.Date(t.dropAt)) + " Uhr – " else "") + "antippen öffnet ${t.windows} Fenster")
                    .setContentIntent(open).setDeleteIntent(silence).setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_ALARM)
                    .build()
                ctx.getSystemService(NotificationManager::class.java).notify(alertId++, n)
            }
        }
        save(ctx)
        scheduleStarts(ctx)
    }

    private fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.deleteNotificationChannel("fox_alert")
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, "Alarme", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Wenn eine Warteschlange aufgeht oder ein Drop live ist"
            enableVibration(false)
        })
        nm.createNotificationChannel(NotificationChannel(CH_CAPTCHA, "Fenster-Hinweise", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Wenn in einem Fox-Queue-Fenster ein Captcha auftaucht oder Android ein Fenster anhält"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 300, 150, 300, 150, 300)
        })
        nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "Monitor läuft", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Dauerhafte Anzeige, solange überwacht wird"
        })
    }
}
