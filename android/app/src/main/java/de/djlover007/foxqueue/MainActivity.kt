package de.djlover007.foxqueue

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.load(this)
        window.statusBarColor = 0xFF0F1115.toInt()
        window.navigationBarColor = 0xFF161920.toInt()

        web = WebView(this).apply {
            setBackgroundColor(0xFF0F1115.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            addJavascriptInterface(Bridge(), "AndroidFox")
            webChromeClient = WebChromeClient() // für alert()/confirm()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    val u = req.url
                    if (u.scheme == "file") return false
                    startActivity(Intent(Intent.ACTION_VIEW, u)); return true
                }
            }
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(web)

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        intent?.let { handleIntent(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        when (intent.action) {
            Updater.ACTION_INSTALL_STATUS -> Updater.handleInstallStatus(this, intent)
            ACTION_AUTO_OPEN -> {
                // Von der Vollbild-Benachrichtigung: Bildschirm an, ggf. Entsperren anfordern, Seite öffnen. Alarm läuft weiter.
                if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
                val url = intent.getStringExtra("url") ?: return
                val km = getSystemService(android.app.KeyguardManager::class.java)
                fun open() {
                    if (!url.startsWith("http")) return
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { }
                }
                if (Build.VERSION.SDK_INT >= 27 && km.isKeyguardLocked) {
                    km.requestDismissKeyguard(this, object : android.app.KeyguardManager.KeyguardDismissCallback() {
                        override fun onDismissSucceeded() { open() }
                    })
                } else open()
            }
            ACTION_OPEN_ALERT -> {
                Store.stopAlarm()
                intent.getStringExtra("url")?.let { u ->
                    if (u.startsWith("http")) try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))) } catch (_: Exception) { }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        Store.foreground = true
        // Beim Öffnen nach Updates schauen (höchstens einmal pro Stunde)
        if (System.currentTimeMillis() - Updater.lastCheck > 3600_000L) Thread { Updater.check(this) }.start()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { moveTaskToBack(true) }

    private fun askBatteryExemption() {
        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            try {
                @SuppressLint("BatteryLife")
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                startActivity(i)
            } catch (_: Exception) { }
        }
    }

    /** Wird von ui/app.js aufgerufen. Alle Methoden liefern den kompletten Zustand als JSON. */
    companion object {
        const val ACTION_OPEN_ALERT = "de.djlover007.foxqueue.OPEN_ALERT"
        const val ACTION_AUTO_OPEN = "de.djlover007.foxqueue.AUTO_OPEN"
    }

    override fun onPause() { Store.foreground = false; super.onPause() }

    /** Android 14+: Vollbild-Benachrichtigungen müssen erlaubt werden. */
    private fun askFullScreenPermission() {
        if (Build.VERSION.SDK_INT >= 34) {
            val nm = getSystemService(android.app.NotificationManager::class.java)
            if (!nm.canUseFullScreenIntent()) try {
                startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
            } catch (_: Exception) { }
        }
    }

    inner class Bridge {
        private val ctx get() = this@MainActivity

        @JavascriptInterface fun getState(): String = Store.stateJson()

        @JavascriptInterface fun saveConfig(json: String): String {
            val o = JSONObject(json)
            synchronized(Store) {
                Store.intervalSec = maxOf(20, o.optInt("intervalSec", 60))
                Store.webhook = o.optString("webhook", "")
                Store.notify = o.optBoolean("notify", true)
                Store.sound = o.optBoolean("sound", true)
                Store.vibrate = o.optBoolean("vibrate", true)
                Store.openBrowser = o.optBoolean("openBrowser", false)
                Store.applyProxy(o.optString("proxy", ""))
            }
            Store.save(ctx); Store.log("info", "Einstellungen gespeichert.")
            if (Store.openBrowser) runOnUiThread { askFullScreenPermission() }
            return Store.stateJson()
        }

        @JavascriptInterface fun addTarget(json: String): String {
            val o = JSONObject(json)
            val id = java.lang.Long.toString(System.currentTimeMillis(), 36) + (1000..9999).random()
            synchronized(Store) {
                Store.targets.add(Store.Target(id, o.getString("name"), o.getString("url"), o.getString("mode"), o.optString("keyword"), true, o.optString("webhook")))
            }
            Store.save(ctx); Store.log("info", "Ziel hinzugefügt: ${o.getString("name")}")
            return Store.stateJson()
        }

        @JavascriptInterface fun updateTarget(id: String, json: String): String {
            val o = JSONObject(json)
            synchronized(Store) {
                Store.targets.find { it.id == id }?.let {
                    if (o.has("enabled")) { it.enabled = o.getBoolean("enabled"); if (!it.enabled) it.live = false }
                    if (o.has("webhook")) it.webhook = o.optString("webhook")
                }
            }
            Store.save(ctx)
            return Store.stateJson()
        }

        @JavascriptInterface fun removeTarget(id: String): String {
            synchronized(Store) { Store.targets.removeAll { it.id == id } }
            Store.save(ctx)
            return Store.stateJson()
        }

        @JavascriptInterface fun start(): String {
            runOnUiThread { askBatteryExemption() }
            ctx.startForegroundService(Intent(ctx, MonitorService::class.java))
            Store.running = true
            return Store.stateJson()
        }

        @JavascriptInterface fun stop(): String {
            ctx.startService(Intent(ctx, MonitorService::class.java).setAction(MonitorService.ACTION_STOP))
            Store.running = false
            return Store.stateJson()
        }

        @JavascriptInterface fun clearLog(): String { Store.clearLog(); return Store.stateJson() }

        @JavascriptInterface fun testAlert(): String {
            Thread {
                Store.alarm(ctx, Store.Target("test", "Test", "https://github.com/Djlover007", "keyword", "", true),
                    "Test-Alarm", "Wenn du das siehst, funktionieren die Benachrichtigungen.", count = false)
            }.start()
            return Store.stateJson()
        }

        @JavascriptInterface fun stopAlarm(): String { Store.stopAlarm(); return Store.stateJson() }

        @JavascriptInterface fun clearStats(): String { Store.clearStats(ctx); return Store.stateJson() }

        @JavascriptInterface fun checkUpdate(): String {
            Thread { Updater.check(ctx) }.start()
            Updater.status = "checking"
            return Store.stateJson()
        }

        @JavascriptInterface fun installUpdate(): String {
            Updater.install(ctx)
            return Store.stateJson()
        }

        @JavascriptInterface fun openUrl(url: String): String {
            if (url.startsWith("http")) runOnUiThread { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            return Store.stateJson()
        }
    }
}
