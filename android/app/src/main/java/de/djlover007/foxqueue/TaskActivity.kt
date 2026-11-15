package de.djlover007.foxqueue

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Öffnet eine Zielseite in einem eigenen Fenster (eigener Task in der App-Übersicht).
 * So kannst du z. B. in der Warteschlange stehen und gleichzeitig zum Dashboard wechseln
 * oder beides im geteilten Bildschirm nebeneinander haben.
 */
class TaskActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var name: String
    private lateinit var url: String
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var detectJs = ""
    private var captchaShown = false
    private var lastCaptchaAlert = 0L
    private var resumed = false

    /** Schaut alle 2 Sekunden, ob ein Captcha zu sehen ist (löst nichts, meldet nur). */
    private val captchaCheck = object : Runnable {
        override fun run() {
            if (::web.isInitialized && detectJs.isNotEmpty()) web.evaluateJavascript(detectJs) { res ->
                val found = res == "true"
                if (found && !captchaShown) {
                    captchaShown = true
                    // Nicht melden, wenn du das Fenster gerade vor dir hast; höchstens alle 60 s pro Fenster
                    if (!resumed && System.currentTimeMillis() - lastCaptchaAlert > 60_000) {
                        lastCaptchaAlert = System.currentTimeMillis()
                        Store.captchaFound(this@TaskActivity, taskLabel(), url, taskId)
                    }
                } else if (!found && captchaShown) {
                    captchaShown = false
                    Store.captchaGone(this@TaskActivity, taskId)
                }
            }
            handler.postDelayed(this, 2000)
        }
    }

    private fun taskLabel(): String = intent.getIntExtra(EXTRA_NR, 0).let { if (it > 0) "$name #$it" else name }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.ensureLoaded(this)
        detectJs = try { assets.open("captcha-detect.js").bufferedReader().use { it.readText() } } catch (_: Exception) { "" }
        window.statusBarColor = 0xFF0F1115.toInt()
        window.navigationBarColor = 0xFF161920.toInt()

        url = intent.getStringExtra(EXTRA_URL)?.takeIf { it.startsWith("http") } ?: run { finishAndRemoveTask(); return }
        name = intent.getStringExtra(EXTRA_NAME).orEmpty().ifBlank { Uri.parse(url).host ?: "Seite" }
        val nr = intent.getIntExtra(EXTRA_NR, 0)

        // Name in der App-Übersicht, damit man die Fenster auseinanderhalten kann
        val title = if (nr > 0) "🦊 $name #$nr" else "🦊 $name"
        if (Build.VERSION.SDK_INT >= 33) {
            setTaskDescription(ActivityManager.TaskDescription.Builder().setLabel(title).setPrimaryColor(0xFF0F1115.toInt()).build())
        } else {
            @Suppress("DEPRECATION")
            setTaskDescription(ActivityManager.TaskDescription(title, null as android.graphics.Bitmap?, 0xFF0F1115.toInt()))
        }

        CookieManager.getInstance().setAcceptCookie(true)
        web = WebView(this).apply {
            setBackgroundColor(0xFF0F1115.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true) // Queue-it braucht Cookies
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    val u = req.url
                    if (u.scheme == "http" || u.scheme == "https") return false
                    // z. B. intent://, mailto:, App-Links → an das System geben
                    try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) { }
                    return true
                }
            }
            if (savedInstanceState != null) restoreState(savedInstanceState) else loadUrl(this@TaskActivity.url)
        }
        setContentView(web)
        handler.postDelayed(captchaCheck, 3000)
    }

    override fun onResume() { super.onResume(); resumed = true; Store.captchaGone(this, taskId) }
    override fun onPause() { resumed = false; super.onPause() }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack()
        else finishAndRemoveTask() // Fenster schließen und aus der Übersicht entfernen
    }

    override fun onDestroy() {
        handler.removeCallbacks(captchaCheck)
        Store.captchaGone(this, taskId)
        if (::web.isInitialized) { web.stopLoading(); web.destroy() }
        CookieManager.getInstance().flush()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_NAME = "name"
        const val EXTRA_NR = "nr"
        /** Obergrenze, jedes Fenster ist ein eigener Browser und braucht Speicher. */
        const val MAX_WINDOWS = 20

        /** Startet die Seite [count]-mal, jedes Mal als eigenen Task (eigene Karte in der App-Übersicht). */
        fun open(ctx: Context, url: String, name: String, count: Int = 1) {
            val n = count.coerceIn(1, MAX_WINDOWS)
            for (i in 1..n) {
                val intent = Intent(ctx, TaskActivity::class.java).apply {
                    putExtra(EXTRA_URL, url)
                    putExtra(EXTRA_NAME, name)
                    putExtra(EXTRA_NR, if (n > 1) i else 0)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                }
                // Alle direkt nacheinander starten, solange Fox Queue noch im Vordergrund ist
                ctx.startActivity(intent)
            }
        }
    }
}
