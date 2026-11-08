package com.quasar.mobile

import android.content.Context
import android.util.Base64
import org.json.JSONObject

/** Один профиль Sudoku — те же поля, что у Квазара на ПК (mihomo, proxy type: sudoku). */
data class Profile(
    val name: String, val host: String, val port: Int, val key: String,
    val aead: String = "chacha20-poly1305", val table: String = "prefer_ascii",
    val pmin: Int = 2, val pmax: Int = 7,
)

object Links {
    /** Достаёт из ссылки quasar:// (или из обычного JSON-пакета) все профили Sudoku. */
    fun parseQuasar(text: String): List<Profile> {
        val t = text.trim()
        require(t.startsWith("quasar://")) { "Нужна ссылка quasar://" }
        val raw = Base64.decode(t.removePrefix("quasar://"), Base64.URL_SAFE or Base64.NO_WRAP)
        val obj = JSONObject(String(raw, Charsets.UTF_8))
        require(obj.optInt("v") == 1) { "Ссылка от другой версии Квазара" }
        val items = obj.getJSONArray("items")
        val out = ArrayList<Profile>()
        for (i in 0 until items.length()) {
            val it = items.getJSONObject(i)
            if (it.optString("proto") != "sudoku") continue
            val x = it.optJSONObject("x") ?: continue
            val key = x.optString("key"); if (key.isEmpty()) continue
            out += Profile(
                name = it.optString("name", "Sudoku"), host = it.getString("host"), port = it.getInt("port"), key = key,
                aead = x.optString("aead", "chacha20-poly1305").ifEmpty { "chacha20-poly1305" },
                table = x.optString("table", "prefer_ascii").ifEmpty { "prefer_ascii" },
                pmin = x.optInt("pmin", 2), pmax = x.optInt("pmax", 7),
            )
        }
        require(out.isNotEmpty()) { "В ссылке нет Sudoku. Включи Sudoku на сервере и возьми ссылку заново" }
        return out
    }
}

object Store {
    private const val F = "quasar"
    fun save(c: Context, p: Profile, ruDirect: Boolean) {
        c.getSharedPreferences(F, 0).edit()
            .putString("name", p.name).putString("host", p.host).putInt("port", p.port).putString("key", p.key)
            .putString("aead", p.aead).putString("table", p.table).putInt("pmin", p.pmin).putInt("pmax", p.pmax)
            .putBoolean("ru", ruDirect).apply()
    }
    fun load(c: Context): Profile? {
        val s = c.getSharedPreferences(F, 0)
        val host = s.getString("host", null) ?: return null
        val key = s.getString("key", null) ?: return null
        return Profile(s.getString("name", "Sudoku")!!, host, s.getInt("port", 0), key,
            s.getString("aead", "chacha20-poly1305")!!, s.getString("table", "prefer_ascii")!!, s.getInt("pmin", 2), s.getInt("pmax", 7))
    }
    fun ruDirect(c: Context) = c.getSharedPreferences(F, 0).getBoolean("ru", true)
}

object Cfg {
    const val SOCKS_PORT = 10808

    private fun q(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    /** Конфиг mihomo: как на ПК (proxy sudoku, httpmask legacy), плюс правила «российское напрямую». */
    fun mihomo(p: Profile, ruDirect: Boolean): String {
        val pmin = p.pmin.coerceIn(0, 100); val pmax = maxOf(pmin, p.pmax.coerceIn(0, 100))
        val aead = if (p.aead in listOf("chacha20-poly1305", "aes-128-gcm")) p.aead else "chacha20-poly1305"
        val table = if (p.table in listOf("prefer_ascii", "prefer_entropy", "up_ascii_down_entropy", "up_entropy_down_ascii")) p.table else "prefer_ascii"
        val rules = StringBuilder()
        if (ruDirect) {
            for (d in listOf("ru", "su", "xn--p1ai", "vk.com", "vk.me", "vkuser.net", "userapi.com", "mail.ru", "ok.ru", "yandex.net", "yandex.com", "ya.ru", "yastatic.net", "rutube.ru", "gosuslugi.ru"))
                rules.append("  - DOMAIN-SUFFIX,$d,DIRECT\n")
        }
        rules.append("  - MATCH,sudoku\n")
        return """
mixed-port: $SOCKS_PORT
allow-lan: false
bind-address: '127.0.0.1'
mode: rule
log-level: info
ipv6: false
geo-auto-update: false
dns:
  enable: true
  ipv6: false
  default-nameserver: [77.88.8.8, 77.88.8.1]
  nameserver: [77.88.8.8, 77.88.8.1]
proxies:
  - name: sudoku
    type: sudoku
    server: ${q(p.host)}
    port: ${p.port}
    key: ${q(p.key)}
    aead-method: $aead
    padding-min: $pmin
    padding-max: $pmax
    table-type: $table
    enable-pure-downlink: false
    httpmask:
      disable: false
      mode: legacy
rules:
$rules""".trimStart()
    }

    /** Конфиг туннеля hev-socks5-tunnel: TUN → локальный SOCKS5 ядра. Имена сайтов подменяются (mapdns) и решаются на стороне сервера. */
    fun hev(): String = """
tunnel:
  mtu: 8500
  ipv4: 198.18.0.1
socks5:
  port: $SOCKS_PORT
  address: 127.0.0.1
  udp: 'udp'
mapdns:
  address: 198.18.0.2
  port: 53
  network: 100.64.0.0
  netmask: 255.192.0.0
  cache-size: 10000
misc:
  log-level: warn
""".trimStart()
}
