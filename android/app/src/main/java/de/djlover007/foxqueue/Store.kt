package de.djlover007.foxqueue

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Notification
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Zentraler Zustand + Überwachungslogik. Keine Proxies, kein Captcha-Lösen – nur normale Abrufe. */
object Store {
    const val CH_ALERT = "fox_alert"
    const val CH_SERVICE = "fox_service"
    private const val UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 FoxQueue/1.0"

    data class Target(
        val id: String, var name: String, var url: String, var mode: String, var keyword: String, var enabled: Boolean,
        var status: String = "Wartet", var live: Boolean = false, var lastCheck: Long = 0, var lastError: String = "", var hash: String? = null,
    )

    @Volatile var running = false
    var intervalSec = 60
    var webhook = ""
    var notify = true
    val targets = mutableListOf<Target>()
    var alerts = 0; var errors = 0; var checks = 0
    private val log = ArrayList<JSONObject>()
    private var loaded = false
    private var alertId = 1000

    // ---------- Speicher ----------
    @Synchronized fun load(ctx: Context) {
        if (loaded) return
        loaded = true
        createChannels(ctx)
        val p = ctx.getSharedPreferences("fox", Context.MODE_PRIVATE)
        intervalSec = p.getInt("interval", 60)
        webhook = p.getString("webhook", "") ?: ""
        notify = p.getBoolean("notify", true)
        val arr = JSONArray(p.getString("targets", "[]"))
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            targets.add(Target(o.getString("id"), o.getString("name"), o.getString("url"), o.getString("mode"), o.optString("keyword"), o.optBoolean("enabled", true)))
        }
    }

    @Synchronized fun save(ctx: Context) {
        val arr = JSONArray()
        targets.forEach {
            arr.put(JSONObject().put("id", it.id).put("name", it.name).put("url", it.url).put("mode", it.mode).put("keyword", it.keyword).put("enabled", it.enabled))
        }
        ctx.getSharedPreferences("fox", Context.MODE_PRIVATE).edit()
            .putInt("interval", intervalSec).putString("webhook", webhook).putBoolean("notify", notify)
            .putString("targets", arr.toString()).apply()
    }

    @Synchronized fun log(type: String, msg: String) {
        log.add(0, JSONObject().put("t", System.currentTimeMillis()).put("type", type).put("msg", msg))
        while (log.size > 300) log.removeAt(log.size - 1)
    }

    @Synchronized fun clearLog() = log.clear()

    @Synchronized fun stateJson(): String {
        val ts = JSONArray()
        targets.forEach {
            ts.put(JSONObject().put("id", it.id).put("name", it.name).put("url", it.url).put("mode", it.mode).put("keyword", it.keyword)
                .put("enabled", it.enabled).put("status", it.status).put("live", it.live).put("lastCheck", it.lastCheck).put("lastError", it.lastError))
        }
        return JSONObject()
            .put("running", running).put("platform", "android")
            .put("config", JSONObject().put("intervalSec", intervalSec).put("webhook", webhook).put("notify", notify).put("openBrowser", false))
            .put("targets", ts)
            .put("stats", JSONObject().put("alerts", alerts).put("errors", errors).put("checks", checks))
            .put("log", JSONArray(log))
            .toString()
    }

    @Synchronized fun resetRun() {
        alerts = 0; errors = 0; checks = 0
        targets.forEach { it.live = false; it.hash = null; it.lastError = "" }
    }

    // ---------- Abruf ----------
    private fun isQueueIt(u: String) = try { URL(u).host.lowercase().let { it == "queue-it.net" || it.endsWith(".queue-it.net") } } catch (e: Exception) { false }

    private fun pageText(html: String) = html
        .replace(Regex("(?is)<script.*?</script>"), " ")
        .replace(Regex("(?is)<style.*?</style>"), " ")
        .replace(Regex("<[^>]+>"), " ")
        .replace("&nbsp;", " ").replace("&amp;", "&")
        .replace(Regex("\\s+"), " ").trim()

    private class Result(val live: Boolean, val status: String, val hash: String? = null)

    private fun fetch(t: Target): Result {
        var url = t.url
        var conn: HttpURLConnection? = null
        // Weiterleitungen selbst folgen (auch http↔https), max. 8
        for (i in 0 until 8) {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 15000; readTimeout = 20000
                setRequestProperty("User-Agent", UA)
                setRequestProperty("Accept-Language", "de-DE,de;q=0.9,en;q=0.8")
                setRequestProperty("Cache-Control", "no-cache")
            }
            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location") ?: break
                url = URL(URL(url), loc).toString()
                conn.disconnect()
                continue
            }
            break
        }
        val c = conn!!
        val code = c.responseCode
        val redirectedToQueue = isQueueIt(url) && !isQueueIt(t.url)
        if (code >= 400 && !redirectedToQueue) {
            c.disconnect()
            val hint = if (code == 403 || code == 429) " – Seite blockiert automatische Abrufe, Intervall erhöhen" else ""
            throw Exception("HTTP $code$hint")
        }
        val stream = if (code >= 400) c.errorStream else c.inputStream
        val html = stream?.use { s ->
            val bytes = s.readBytes()
            String(bytes, 0, minOf(bytes.size, 3_000_000), Charsets.UTF_8)
        } ?: ""
        c.disconnect()

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
    fun runRound(ctx: Context) {
        val list = synchronized(this) { targets.filter { it.enabled } }
        for (t in list) {
            if (!running) return
            try {
                val r = fetch(t)
                synchronized(this) {
                    checks++
                    t.lastCheck = System.currentTimeMillis()
                    if (t.lastError.isNotEmpty()) log("info", "${t.name}: wieder erreichbar")
                    t.lastError = ""
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
                val msg = if (e is java.net.SocketTimeoutException) "Zeitüberschreitung" else (e.message ?: e.javaClass.simpleName)
                synchronized(this) {
                    errors++
                    t.lastCheck = System.currentTimeMillis()
                    if (t.lastError != msg) log("error", "${t.name}: $msg")
                    t.lastError = msg
                }
            }
            Thread.sleep(400L + (Math.random() * 600).toLong())
        }
    }

    // ---------- Alarm ----------
    fun alarm(ctx: Context, t: Target, title: String, body: String, count: Boolean = true) {
        synchronized(this) { if (count) alerts++; log("alert", "🦊 $title: ${t.name}") }
        if (notify) {
            val open = PendingIntent.getActivity(
                ctx, alertId, Intent(Intent.ACTION_VIEW, Uri.parse(t.url)),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val n = Notification.Builder(ctx, CH_ALERT)
                .setSmallIcon(R.drawable.ic_stat_fox)
                .setContentTitle("🦊 $title")
                .setContentText("${t.name} – antippen zum Öffnen")
                .setStyle(Notification.BigTextStyle().bigText("${t.name}\n$body\n${t.url}"))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(alertId++, n)
        }
        if (webhook.isNotBlank()) sendDiscord(title, t.name, body, t.url)
    }

    private fun sendDiscord(title: String, name: String, body: String, url: String) {
        try {
            val payload = JSONObject()
                .put("username", "Fox Queue")
                .put("embeds", JSONArray().put(JSONObject()
                    .put("title", "🦊 $title").put("description", "**$name**\n$body").put("url", url).put("color", 0xE8893A)))
            val c = (URL(webhook).openConnection() as HttpURLConnection).apply {
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

    private fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, "Alarme", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Wenn eine Warteschlange aufgeht oder ein Drop live ist"
            enableVibration(true)
        })
        nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "Monitor läuft", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Dauerhafte Anzeige, solange überwacht wird"
        })
    }
}
