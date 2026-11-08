package com.quasar.mobile

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import kotlin.concurrent.thread

/** Окно Квазара: тот же интерфейс, что на ПК, в WebView. Квазар (Node) работает внутри приложения. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    @Volatile private var loaded = false

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            useWideViewPort = true; loadWithOverviewMode = true
            setSupportZoom(true); builtInZoomControls = true; displayZoomControls = false
        }
        web.webViewClient = object : WebViewClient() {
            // Windows-функции, которых на Android нет, прячем: «Раздача» и «Системный прокси»
            override fun onPageFinished(v: WebView, url: String?) {
                v.evaluateJavascript(HIDE_JS, null)
            }
        }
        web.webChromeClient = WebChromeClient()
        setContentView(web)
        web.loadData("<html><body style='background:#111;color:#ddd;font:18px sans-serif;padding:24px'>Квазар запускается…</body></html>", "text/html", "utf-8")

        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
        val i = VpnService.prepare(this)   // разрешение на VPN нужно один раз
        if (i != null) startActivityForResult(i, 1)
        startForegroundService(Intent(this, CoreService::class.java))
        waitForQuasar()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(rc: Int, res: Int, d: Intent?) { /* разрешение сохраняется системой */ }

    private fun waitForQuasar() {
        thread(name = "wait-quasar") {
            val f = NodeHost.instanceFile(this)
            for (n in 0 until 240) {
                try {
                    if (f.exists()) {
                        val url = JSONObject(f.readText()).getString("url")
                        runOnUiThread { loaded = true; web.loadUrl(url) }
                        return@thread
                    }
                } catch (_: Throwable) {}
                Thread.sleep(250)
            }
            val err = try { java.io.File(NodeHost.dataDir(this), "node-exit.txt").readText() } catch (_: Throwable) { "Квазар не ответил за минуту" }
            runOnUiThread { web.loadData("<html><body style='background:#111;color:#f88;font:16px sans-serif;padding:24px'>$err</body></html>", "text/html", "utf-8") }
        }
    }

    override fun onKeyDown(code: Int, e: KeyEvent?): Boolean {
        if (code == KeyEvent.KEYCODE_BACK) { if (web.canGoBack()) web.goBack() else moveTaskToBack(true); return true }
        return super.onKeyDown(code, e)
    }

    private val HIDE_JS = """
(function(){ if (window.__qh) return; window.__qh = 1;
  function hide(){
    document.querySelectorAll('#nav button').forEach(function(b){ if (b.textContent.trim()==='Раздача') b.style.display='none'; });
    document.querySelectorAll('label, .check, .tick').forEach(function(l){ if (/Системный прокси/.test(l.textContent) && l.textContent.length<40) l.style.display='none'; });
  }
  new MutationObserver(hide).observe(document.body,{childList:true,subtree:true}); hide();
})();"""
}
