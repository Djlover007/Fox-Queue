package de.djlover007.foxqueue

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * Öffnet eine Zielseite in einem eigenen Fenster (eigener Task in der App-Übersicht).
 * So kannst du z. B. in der Warteschlange stehen und gleichzeitig zum Dashboard wechseln
 * oder beides im geteilten Bildschirm nebeneinander haben.
 *
 * Das Fenster beobachtet die Seite (liest nur, klickt und löst nichts):
 * Captcha zu sehen? In der Warteschlange? Welcher Platz? Warteschlange durch → „Du bist dran“.
 */
class TaskActivity : Activity() {
    private var web: WebView? = null
    private lateinit var name: String
    private lateinit var url: String
    private val handler = Handler(Looper.getMainLooper())
    private var detectJs = ""
    private var resumed = false
    private var loading = true
    private var lastUrl = ""

    private var captchaShown = false
    private var lastCaptchaAlert = 0L

    private var hostQueue = false     // Warteschlange unter eigener Adresse (Queue-it)
    private var pageQueue = false     // Warteseite unter der Adresse des Shops
    private var notQueuePolls = 0
    private var passed = false

    // Wartemodus: Fenster zeigt die Warteseite und lädt den Shop erst, wenn der Monitor des Ziels anschlägt
    private var targetId = ""
    private var waiting = false
    private var waitSince = 0L

    private fun taskLabel(): String = intent.getIntExtra(EXTRA_NR, 0).let { if (it > 0) "$name #$it" else name }

    /** Queue-it oder eigene Queue-Adresse des Shops (queue.shop.de, warteraum.shop.de …)? */
    private fun isQueue(u: String?): Boolean {
        val h = try { Uri.parse(u ?: return false).host?.lowercase() } catch (_: Exception) { null } ?: return false
        return h == "queue-it.net" || h.endsWith(".queue-it.net") ||
            Regex("^(queue|queueing|warteraum|waitingroom|waiting-room)\\.").containsMatchIn(h)
    }

    private fun firePassed() {
        passed = true
        Store.queuePassed(this, taskLabel(), url, taskId, looking = resumed)
    }

    /** Bei jedem Seitenwechsel: Queue-Adresse verlassen = du bist dran. */
    private fun onNavigated(u: String?) {
        if (u == null || !u.startsWith("http")) return
        lastUrl = u
        if (isQueue(u)) { hostQueue = true; passed = false; return }
        if (hostQueue) { hostQueue = false; pageQueue = false; firePassed() }
    }

    /** Ergebnis von ui/page-detect.js auswerten. */
    private fun onDetect(res: String?) {
        val d = try { JSONObject(res ?: return) } catch (_: Exception) { return }
        val onHost = isQueue(lastUrl)
        val pq = d.optBoolean("queue")

        // Warteseite unter der Adresse des Shops (Cloudflare Waiting Room u. ä.):
        // erst „durch“, wenn die fertig geladene Seite zweimal hintereinander keine Warteseite mehr ist
        if (pq && !onHost) { pageQueue = true; notQueuePolls = 0; passed = false }
        else if (pageQueue && !onHost && d.optBoolean("ready")) {
            notQueuePolls++
            if (notQueuePolls >= 2) { pageQueue = false; firePassed() }
        }
        val inQueue = onHost || pq

        val captcha = d.optBoolean("captcha")
        if (captcha && !captchaShown) {
            captchaShown = true
            // Nicht melden, wenn du das Fenster gerade vor dir hast; höchstens alle 60 s pro Fenster
            if (!resumed && System.currentTimeMillis() - lastCaptchaAlert > 60_000) {
                lastCaptchaAlert = System.currentTimeMillis()
                Store.captchaFound(this, taskLabel(), url, taskId)
                // Dashboard gerade offen → dieses Fenster von selbst nach vorn holen.
                // (Aus dem Hintergrund erlaubt Android das nicht; dann bleibt es bei der Meldung.)
                if (Store.captchaNotify && Store.captchaFront && Store.foreground) Store.focusWindow(this, taskId)
            }
        } else if (!captcha && captchaShown) {
            captchaShown = false
            Store.captchaGone(this, taskId)
        }

        val status = when {
            captcha -> "captcha"
            inQueue -> "queue"
            passed -> "passed"
            loading -> "loading"
            else -> "open"
        }
        Store.reportWindow(taskId, taskLabel(), lastUrl.ifEmpty { url }, status,
            if (inQueue) d.optString("pos") else "", if (inQueue) d.optString("wait") else "", targetId)
    }

    /** Schaut alle 2 Sekunden auf die Seite. */
    private val poll = object : Runnable {
        override fun run() {
            val w = web
            if (waiting) Store.reportWindow(taskId, taskLabel(), url, "waiting", "", "", targetId)
            else if (w != null && detectJs.isNotEmpty()) try { w.evaluateJavascript(detectJs) { onDetect(it) } } catch (_: Exception) { }
            handler.postDelayed(this, 2000)
        }
    }

    /** Schaut alle 300 ms, ob der Monitor angeschlagen hat (nur im Wartemodus). */
    private val waitPoll = object : Runnable {
        override fun run() {
            if (!waiting) return
            if ((Store.releasedAt[targetId] ?: 0L) > waitSince) release()
            else handler.postDelayed(this, 300)
        }
    }

    /** Shop laden – je nach Fensternummer leicht versetzt, damit nicht alle Fenster in derselben Millisekunde anfragen. */
    private fun release() {
        if (!waiting) return
        waiting = false
        loading = true
        val nr = maxOf(1, intent.getIntExtra(EXTRA_NR, 1))
        handler.postDelayed({ web?.loadUrl(url) }, (nr - 1) * 250L + (Math.random() * 250).toLong())
        Store.reportWindow(taskId, taskLabel(), url, "loading", "", "", targetId)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.ensureLoaded(this)
        detectJs = try { assets.open("page-detect.js").bufferedReader().use { it.readText() } } catch (_: Exception) { "" }
        window.statusBarColor = 0xFF0F1115.toInt()
        window.navigationBarColor = 0xFF161920.toInt()

        url = intent.getStringExtra(EXTRA_URL)?.takeIf { it.startsWith("http") } ?: run { finishAndRemoveTask(); return }
        name = intent.getStringExtra(EXTRA_NAME).orEmpty().ifBlank { Uri.parse(url).host ?: "Seite" }
        lastUrl = url
        targetId = intent.getStringExtra(EXTRA_TARGET).orEmpty()
        waiting = intent.getBooleanExtra(EXTRA_WAIT, false)
        waitSince = System.currentTimeMillis()

        // Name in der App-Übersicht, damit man die Fenster auseinanderhalten kann
        val title = "🦊 ${taskLabel()}"
        if (Build.VERSION.SDK_INT >= 33) {
            setTaskDescription(ActivityManager.TaskDescription.Builder().setLabel(title).setPrimaryColor(0xFF0F1115.toInt()).build())
        } else {
            @Suppress("DEPRECATION")
            setTaskDescription(ActivityManager.TaskDescription(title, null as Bitmap?, 0xFF0F1115.toInt()))
        }

        if (savedInstanceState != null) {
            hostQueue = savedInstanceState.getBoolean("hostQueue")
            pageQueue = savedInstanceState.getBoolean("pageQueue")
            passed = savedInstanceState.getBoolean("passed")
            waiting = savedInstanceState.getBoolean("waiting")
            waitSince = savedInstanceState.getLong("waitSince", waitSince)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        buildWeb(savedInstanceState, if (waiting) waitPage() else url)
        Store.reportWindow(taskId, taskLabel(), url, if (waiting) "waiting" else "loading", "", "", targetId)
        handler.postDelayed(poll, 3000)
        if (waiting) {
            // Ziel ist schon „live“ → gar nicht erst warten
            if (Store.targetLive(targetId)) release() else handler.post(waitPoll)
        }
    }

    private fun waitPage() = "file:///android_asset/wait.html?name=" + Uri.encode(taskLabel())

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWeb(saved: Bundle?, load: String) {
        val w = WebView(this)
        w.setBackgroundColor(0xFF0F1115.toInt())
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.loadWithOverviewMode = true
        w.settings.useWideViewPort = true
        w.settings.builtInZoomControls = true
        w.settings.displayZoomControls = false
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true) // Queue-it braucht Cookies
        w.webChromeClient = WebChromeClient()
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "http" || u.scheme == "https") return false
                // z. B. intent://, mailto:, App-Links → an das System geben
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) { }
                return true
            }

            override fun doUpdateVisitedHistory(view: WebView, u: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, u, isReload)
                onNavigated(u)
            }

            override fun onPageStarted(view: WebView, u: String?, favicon: Bitmap?) { loading = true }
            override fun onPageFinished(view: WebView, u: String?) { loading = false }

            /** Android hat den Browser-Prozess dieses Fensters beendet (Speicher knapp) → Fenster neu aufbauen. */
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                val back = if (waiting) waitPage() else lastUrl.ifEmpty { url }
                handler.post { rebuild(back) }
                return true
            }
        }
        if (saved == null || w.restoreState(saved) == null) w.loadUrl(load)
        web = w
        setContentView(w)
    }

    private fun rebuild(u: String) {
        if (isDestroyed || isFinishing) return
        val old = web
        web = null
        try { (old?.parent as? ViewGroup)?.removeView(old); old?.destroy() } catch (_: Exception) { }
        Store.log("info", "Fenster neu geladen (Android hatte es angehalten): ${taskLabel()}")
        loading = true
        buildWeb(null, u)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        Store.captchaGone(this, taskId)
        // Du bist im klingelnden Fenster angekommen → Ton aus
        if (Store.ringingTask == taskId) Store.stopAlarm()
        val nm = getSystemService(NotificationManager::class.java)
        nm.cancel(90_000 + taskId); nm.cancel(95_000 + taskId)
    }

    override fun onPause() { resumed = false; super.onPause() }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("hostQueue", hostQueue)
        outState.putBoolean("pageQueue", pageQueue)
        outState.putBoolean("passed", passed)
        outState.putBoolean("waiting", waiting)
        outState.putLong("waitSince", waitSince)
        web?.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val w = web
        if (w != null && w.canGoBack()) w.goBack()
        else finishAndRemoveTask() // Fenster schließen und aus der Übersicht entfernen
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (::url.isInitialized) {
            Store.captchaGone(this, taskId)
            if (isFinishing) Store.windows.remove(taskId)
            else if (!isChangingConfigurations) Store.windowKilled(this, taskId, taskLabel())
        }
        web?.let { it.stopLoading(); it.destroy() }
        web = null
        CookieManager.getInstance().flush()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_NAME = "name"
        const val EXTRA_NR = "nr"
        const val EXTRA_TARGET = "targetId"
        const val EXTRA_WAIT = "wait"

        /** Fenster eines Ziels: mit dessen Adresse für die Fenster und, falls eingestellt, im Wartemodus. */
        fun openFor(ctx: Context, t: Store.Target, count: Int = t.windows) =
            open(ctx, t.openUrl.ifBlank { t.url }, t.name, count, t.id, t.waitMode)

        /** Startet die Seite [count]-mal, jedes Mal als eigenen Task (eigene Karte in der App-Übersicht). */
        fun open(ctx: Context, url: String, name: String, count: Int = 1, targetId: String = "", wait: Boolean = false) {
            val n = count.coerceIn(1, Store.MAX_WINDOWS)
            for (i in 1..n) {
                val intent = Intent(ctx, TaskActivity::class.java).apply {
                    putExtra(EXTRA_URL, url)
                    putExtra(EXTRA_NAME, name)
                    putExtra(EXTRA_NR, if (n > 1) i else 0)
                    putExtra(EXTRA_TARGET, targetId)
                    putExtra(EXTRA_WAIT, wait)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                }
                // Alle direkt nacheinander starten, solange Fox Queue noch im Vordergrund ist
                ctx.startActivity(intent)
            }
        }
    }
}
