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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = 0xFF0F1115.toInt()
        window.navigationBarColor = 0xFF161920.toInt()

        val url = intent.getStringExtra(EXTRA_URL)?.takeIf { it.startsWith("http") }
        if (url == null) { finishAndRemoveTask(); return }
        val name = intent.getStringExtra(EXTRA_NAME).orEmpty().ifBlank { Uri.parse(url).host ?: "Seite" }

        // Name in der App-Übersicht, damit man die Fenster auseinanderhalten kann
        val title = "🦊 $name"
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
            if (savedInstanceState != null) restoreState(savedInstanceState) else loadUrl(url)
        }
        setContentView(web)
    }

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
        if (::web.isInitialized) { web.stopLoading(); web.destroy() }
        CookieManager.getInstance().flush()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_NAME = "name"

        /** Startet die Seite als eigenen Task (eigene Karte in der App-Übersicht). */
        fun open(ctx: Context, url: String, name: String) {
            val intent = Intent(ctx, TaskActivity::class.java).apply {
                putExtra(EXTRA_URL, url)
                putExtra(EXTRA_NAME, name)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
            }
            ctx.startActivity(intent)
        }
    }
}
