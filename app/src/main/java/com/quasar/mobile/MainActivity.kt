package com.quasar.mobile

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.*
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var link: EditText
    private lateinit var spin: Spinner
    private lateinit var host: EditText
    private lateinit var port: EditText
    private lateinit var key: EditText
    private lateinit var ru: CheckBox
    private lateinit var btn: Button
    private lateinit var logv: TextView
    private var items: List<JSONObject> = emptyList()

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun label(t: String) = TextView(this).apply { text = t; textSize = 13f }
        fun edit(h: String, multi: Boolean = false) = EditText(this).apply { hint = h; if (multi) { minLines = 2; maxLines = 4 } else isSingleLine = true }

        root.addView(TextView(this).apply { text = "Квазар (TUN)"; textSize = 20f })
        root.addView(label("Ссылка quasar:// из ПК-Квазара или обычные ссылки (vless://, hy2://, …)"))
        link = edit("quasar://…", true); root.addView(link)
        val imp = Button(this).apply { text = "Загрузить протоколы из ссылки" }; root.addView(imp)
        root.addView(label("Протокол"))
        spin = Spinner(this); root.addView(spin)
        root.addView(label("Или Sudoku вручную"))
        host = edit("Адрес сервера"); root.addView(host)
        port = edit("Порт (например 54321)").apply { inputType = InputType.TYPE_CLASS_NUMBER }; root.addView(port)
        key = edit("Ключ Sudoku"); root.addView(key)
        val man = Button(this).apply { text = "Добавить этот Sudoku" }; root.addView(man)
        ru = CheckBox(this).apply { text = "Российские сайты напрямую (.ru, VK, Яндекс, Госуслуги, Rutube)"; isChecked = Store.ruDirect(this@MainActivity) }
        root.addView(ru)
        btn = Button(this); root.addView(btn)
        logv = TextView(this).apply { textSize = 11f; typeface = android.graphics.Typeface.MONOSPACE; gravity = Gravity.START }
        root.addView(ScrollView(this).apply { addView(logv) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)

        items = Store.items(this); fillSpinner()
        spin.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) { Store.select(this@MainActivity, pos) }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        imp.setOnClickListener {
            try {
                items = Links.parse(link.text.toString()); Store.saveItems(this, items); Store.select(this, 0); fillSpinner()
                Log.add("Загружено протоколов: ${items.size}")
            } catch (e: Throwable) { Log.add("Ссылка не подошла: ${e.message}") }
        }
        man.setOnClickListener {
            val po = port.text.toString().toIntOrNull()
            if (host.text.isBlank() || po == null || key.text.isBlank()) { Log.add("Заполни адрес, порт и ключ"); return@setOnClickListener }
            val it = JSONObject().put("proto", "sudoku").put("name", "Sudoku").put("host", host.text.toString().trim()).put("port", po)
                .put("x", JSONObject().put("key", key.text.toString().trim()).put("aead", "chacha20-poly1305").put("table", "prefer_ascii").put("pmin", 2).put("pmax", 7))
            items = listOf(it) + items; Store.saveItems(this, items); Store.select(this, 0); fillSpinner()
        }
        btn.setOnClickListener { if (QuasarVpn.running) stopVpn() else startVpn() }
    }

    private fun fillSpinner() {
        spin.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, items.map { Protos.title(it) })
    }

    override fun onResume() {
        super.onResume()
        Log.listener = { logv.text = it }; logv.text = Log.text(); refresh()
    }
    override fun onPause() { Log.listener = null; super.onPause() }
    private fun refresh() { btn.text = if (QuasarVpn.running) "Отключить" else "Подключить" }

    private fun startVpn() {
        if (items.isEmpty()) { Log.add("Сначала загрузи ссылку или добавь Sudoku"); return }
        Store.setRu(this, ru.isChecked)
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
