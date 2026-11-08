package com.quasar.mobile

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.*

class MainActivity : Activity() {
    private lateinit var link: EditText
    private lateinit var host: EditText
    private lateinit var port: EditText
    private lateinit var key: EditText
    private lateinit var ru: CheckBox
    private lateinit var btn: Button
    private lateinit var logv: TextView

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun label(t: String) = TextView(this).apply { text = t; textSize = 13f }
        fun edit(h: String, multi: Boolean = false) = EditText(this).apply { hint = h; if (multi) { minLines = 2; maxLines = 4 } else isSingleLine = true }

        root.addView(TextView(this).apply { text = "Квазар · Sudoku (TUN)"; textSize = 20f })
        root.addView(label("Ссылка quasar:// из ПК-Квазара (Серверы → Ссылка)"))
        link = edit("quasar://…", true); root.addView(link)
        val imp = Button(this).apply { text = "Взять Sudoku из ссылки" }; root.addView(imp)
        root.addView(label("Или вручную"))
        host = edit("Адрес сервера"); root.addView(host)
        port = edit("Порт (например 54321)").apply { inputType = InputType.TYPE_CLASS_NUMBER }; root.addView(port)
        key = edit("Ключ Sudoku"); root.addView(key)
        ru = CheckBox(this).apply { text = "Российские сайты напрямую (.ru, VK, Яндекс, Госуслуги, Rutube)"; isChecked = Store.ruDirect(this@MainActivity) }
        root.addView(ru)
        btn = Button(this); root.addView(btn)
        logv = TextView(this).apply { textSize = 11f; typeface = android.graphics.Typeface.MONOSPACE; gravity = Gravity.START }
        root.addView(ScrollView(this).apply { addView(logv) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)

        Store.load(this)?.let { host.setText(it.host); port.setText(it.port.toString()); key.setText(it.key) }

        imp.setOnClickListener {
            try {
                val list = Links.parseQuasar(link.text.toString())
                val p = list.first()
                host.setText(p.host); port.setText(p.port.toString()); key.setText(p.key)
                Store.save(this, p, ru.isChecked)
                Log.add("Взят профиль «${p.name}» (${p.host}:${p.port}), всего Sudoku в ссылке: ${list.size}")
            } catch (e: Throwable) { Log.add("Ссылка не подошла: ${e.message}") }
        }
        btn.setOnClickListener { if (QuasarVpn.running) stopVpn() else startVpn() }
    }

    override fun onResume() {
        super.onResume()
        Log.listener = { logv.text = it }; logv.text = Log.text(); refresh()
    }
    override fun onPause() { Log.listener = null; super.onPause() }
    private fun refresh() { btn.text = if (QuasarVpn.running) "Отключить" else "Подключить" }

    private fun saveManual(): Boolean {
        val po = port.text.toString().toIntOrNull()
        if (host.text.isBlank() || po == null || key.text.isBlank()) { Log.add("Заполни адрес, порт и ключ"); return false }
        val old = Store.load(this)
        Store.save(this, Profile("Sudoku", host.text.toString().trim(), po, key.text.toString().trim(),
            old?.aead ?: "chacha20-poly1305", old?.table ?: "prefer_ascii", old?.pmin ?: 2, old?.pmax ?: 7), ru.isChecked)
        return true
    }

    private fun startVpn() {
        if (!saveManual()) return
        val i = VpnService.prepare(this)
        if (i != null) startActivityForResult(i, 1) else launch()
    }
    @Deprecated("Deprecated in Java")
    override fun onActivityResult(rc: Int, res: Int, d: Intent?) {
        if (rc == 1 && res == RESULT_OK) launch() else if (rc == 1) Log.add("Разрешение на VPN не дано")
    }
    private fun launch() { startService(Intent(this, QuasarVpn::class.java)); btn.postDelayed({ refresh() }, 3000) }
    private fun stopVpn() { startService(Intent(this, QuasarVpn::class.java).setAction(QuasarVpn.ACTION_STOP)); btn.postDelayed({ refresh() }, 800) }
}
