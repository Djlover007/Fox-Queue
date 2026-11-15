package de.djlover007.foxqueue

import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Auto-Update über die Releases im öffentlichen Repo Fox-Queue-Downloads. */
object Updater {
    private const val API = "https://api.github.com/repos/Djlover007/Fox-Queue-Downloads/releases/latest"
    const val ACTION_INSTALL_STATUS = "de.djlover007.foxqueue.INSTALL_STATUS"

    // idle | checking | latest | available | downloading | installing | error
    @Volatile var status = "idle"
    @Volatile var latest = ""
    @Volatile var progress = 0
    @Volatile var message = ""
    @Volatile var lastCheck = 0L
    private var apkUrl = ""
    private var notifiedVersion = ""

    fun current(ctx: Context): String =
        try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "1.0.0" } catch (e: Exception) { "1.0.0" }

    fun json(ctx: Context): JSONObject = JSONObject()
        .put("status", status).put("latest", latest).put("progress", progress).put("message", message)
        .put("current", current(ctx)).put("canInstall", true)

    /** true, wenn a neuer als b ist (Versionen wie 1.0.12). */
    fun newer(a: String, b: String): Boolean {
        val x = a.trimStart('v').split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.trimStart('v').split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
            if (d != 0) return d > 0
        }
        return false
    }

    /** Läuft im Hintergrund-Thread. */
    @Synchronized fun check(ctx: Context, notifyIfNew: Boolean = false) {
        if (status == "downloading" || status == "installing") return
        status = "checking"; message = ""
        lastCheck = System.currentTimeMillis()
        try {
            val c = (URL(API).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000; readTimeout = 15000
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "FoxQueue-Updater")
            }
            val code = c.responseCode
            if (code == 404) { c.disconnect(); status = "latest"; message = "Noch keine Version veröffentlicht."; return }
            if (code != 200) { c.disconnect(); throw Exception("GitHub antwortet mit HTTP $code") }
            val o = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            c.disconnect()
            val tag = o.getString("tag_name").trimStart('v')
            val assets = o.getJSONArray("assets")
            var url = ""
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.getString("name").endsWith(".apk")) url = a.getString("browser_download_url")
            }
            latest = tag
            if (url.isNotEmpty() && newer(tag, current(ctx))) {
                apkUrl = url
                status = "available"
                Store.log("info", "Update verfügbar: Version $tag")
                if (notifyIfNew && notifiedVersion != tag) { notifiedVersion = tag; notifyUpdate(ctx, tag) }
            } else status = "latest"
        } catch (e: Exception) {
            status = "error"; message = e.message ?: "Update-Prüfung fehlgeschlagen"
        }
    }

    private fun notifyUpdate(ctx: Context, version: String) {
        val open = PendingIntent.getActivity(ctx, 9, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(ctx, Store.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_fox)
            .setContentTitle("Fox Queue Update $version")
            .setContentText("Antippen und in der App auf „Jetzt aktualisieren“ tippen.")
            .setContentIntent(open).setAutoCancel(true).build()
        ctx.getSystemService(NotificationManager::class.java).notify(9, n)
    }

    /** Lädt die APK und startet die Installation. Muss aus der Activity kommen. */
    fun install(act: Activity) {
        if (status != "available" || apkUrl.isEmpty()) return
        if (!act.packageManager.canRequestPackageInstalls()) {
            message = "Bitte erlaube Fox Queue, Apps zu installieren, und tippe dann nochmal auf „Jetzt aktualisieren“."
            act.runOnUiThread {
                act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${act.packageName}")))
            }
            return
        }
        status = "downloading"; progress = 0; message = ""
        Thread {
            try {
                val c = (URL(apkUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20000; readTimeout = 30000
                    setRequestProperty("User-Agent", "FoxQueue-Updater")
                }
                if (c.responseCode != 200) throw Exception("Download: HTTP ${c.responseCode}")
                val total = c.contentLengthLong
                val installer = act.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                val id = installer.createSession(params)
                installer.openSession(id).use { session ->
                    c.inputStream.use { input ->
                        session.openWrite("foxqueue.apk", 0, total).use { out ->
                            val buf = ByteArray(64 * 1024)
                            var done = 0L
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                done += n
                                if (total > 0) progress = (done * 100 / total).toInt()
                            }
                            session.fsync(out)
                        }
                    }
                    c.disconnect()
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    val pi = PendingIntent.getActivity(act, 7, Intent(act, MainActivity::class.java).setAction(ACTION_INSTALL_STATUS), flags)
                    status = "installing"; progress = 100
                    session.commit(pi.intentSender)
                }
            } catch (e: Exception) {
                status = "available"; message = "Update fehlgeschlagen: ${e.message}"
                Store.log("error", message)
            }
        }.start()
    }

    /** Rückmeldung des Systeminstallers an die Activity. */
    fun handleInstallStatus(act: Activity, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) act.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> { status = "latest"; message = "" }
            else -> {
                status = "available"
                message = "Installation abgebrochen: " + (intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unbekannt")
            }
        }
    }
}
