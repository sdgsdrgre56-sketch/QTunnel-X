package com.quasar.mobile

import android.content.Context
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Протоколы, которые умеет это приложение, и какое ядро их ведёт. */
object Protos {
    val NAMES = mapOf(
        "vless" to "VLESS Reality", "hysteria2" to "Hysteria2", "tuic" to "TUIC v5", "anytls" to "AnyTLS", "trojan" to "Trojan",
        "shadowsocks" to "Shadowsocks", "shadowtls" to "ShadowTLS v3", "http" to "HTTP", "socks" to "SOCKS5", "sudoku" to "Sudoku",
    )
    val SINGBOX = setOf("vless", "hysteria2", "tuic", "anytls", "trojan", "shadowsocks", "shadowtls", "http", "socks")
    fun core(proto: String): String? = when (proto) { "sudoku" -> "mihomo"; in SINGBOX -> "sing-box"; else -> null }
    fun title(it: JSONObject) = (Protos.NAMES[it.optString("proto")] ?: it.optString("proto")).let { n ->
        val ok = core(it.optString("proto")) != null && !(it.optString("proto") == "vless" && it.optString("uri").contains("type=xhttp"))
        "$n · ${it.optString("host")}:${it.optInt("port")}" + if (ok) "" else "  (пока нет)"
    }
}

object Links {
    /** Разбирает ссылку quasar:// или обычные ссылки по строкам; возвращает список записей (JSON). */
    fun parse(text: String): List<JSONObject> {
        val t = text.trim()
        require(t.isNotEmpty()) { "Пусто: вставь ссылку" }
        val out = ArrayList<JSONObject>()
        if (t.startsWith("quasar://")) {
            val raw = Base64.decode(t.removePrefix("quasar://"), Base64.URL_SAFE or Base64.NO_WRAP)
            val obj = JSONObject(String(raw, Charsets.UTF_8))
            require(obj.optInt("v") == 1) { "Ссылка от другой версии Квазара" }
            val items = obj.getJSONArray("items")
            for (i in 0 until items.length()) out += items.getJSONObject(i)
        } else {
            for (l in t.split(Regex("\\s+")).filter { it.contains("://") }) out += fromUri(l)
        }
        require(out.isNotEmpty()) { "В ссылке нет протоколов" }
        return out
    }

    private fun fromUri(l: String): JSONObject {
        val u = Uri.parse(l)
        var p = (u.scheme ?: "").lowercase()
        if (p == "hy2") p = "hysteria2"; if (p == "ss") p = "shadowsocks"; if (p == "socks5" || p == "socks5h") p = "socks"
        return JSONObject().put("proto", p).put("name", u.fragment ?: u.host ?: p).put("host", u.host ?: "").put("port", u.port).put("uri", l)
    }
}

object Store {
    private const val F = "quasar"
    fun saveItems(c: Context, items: List<JSONObject>) { c.getSharedPreferences(F, 0).edit().putString("items", JSONArray(items).toString()).apply() }
    fun items(c: Context): List<JSONObject> {
        val a = JSONArray(c.getSharedPreferences(F, 0).getString("items", "[]"))
        return (0 until a.length()).map { a.getJSONObject(it) }
    }
    fun select(c: Context, i: Int) { c.getSharedPreferences(F, 0).edit().putInt("sel", i).apply() }
    fun selected(c: Context): JSONObject? = items(c).getOrNull(c.getSharedPreferences(F, 0).getInt("sel", 0))
    fun setRu(c: Context, v: Boolean) { c.getSharedPreferences(F, 0).edit().putBoolean("ru", v).apply() }
    fun ruDirect(c: Context) = c.getSharedPreferences(F, 0).getBoolean("ru", true)
}

object Cfg {
    const val SOCKS_PORT = 10808
    val RU = listOf("ru", "su", "xn--p1ai", "vk.com", "vk.me", "vkuser.net", "userapi.com", "mail.ru", "ok.ru", "yandex.net", "yandex.com", "ya.ru", "yastatic.net", "rutube.ru", "gosuslugi.ru")

    private fun q(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    // ---------------- mihomo: Sudoku (как на ПК) ----------------
    fun mihomo(item: JSONObject, ruDirect: Boolean): String {
        val x = item.optJSONObject("x") ?: JSONObject()
        val pmin = x.optInt("pmin", 2).coerceIn(0, 100); val pmax = maxOf(pmin, x.optInt("pmax", 7).coerceIn(0, 100))
        val aeadIn = x.optString("aead"); val aead = if (aeadIn in listOf("chacha20-poly1305", "aes-128-gcm")) aeadIn else "chacha20-poly1305"
        val tIn = x.optString("table")
        val table = if (tIn in listOf("prefer_ascii", "prefer_entropy", "up_ascii_down_entropy", "up_entropy_down_ascii")) tIn else "prefer_ascii"
        val rules = StringBuilder()
        if (ruDirect) for (d in RU) rules.append("  - DOMAIN-SUFFIX,$d,DIRECT\n")
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
    server: ${q(item.getString("host"))}
    port: ${item.getInt("port")}
    key: ${q(x.getString("key"))}
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

    // ---------------- sing-box: остальные протоколы (порт lib/clientconf.js из ПК-Квазара) ----------------
    private fun tls(host: String, sni: String, insecure: Boolean, utls: Boolean = false, alpn: Boolean = false) = JSONObject()
        .put("enabled", true).put("server_name", sni.ifEmpty { host }).put("insecure", insecure)
        .apply { if (utls) put("utls", JSONObject().put("enabled", true).put("fingerprint", "chrome")); if (alpn) put("alpn", JSONArray().put("h3")) }

    private fun reality(sni: String, pbk: String, sid: String) = JSONObject().put("enabled", true).put("server_name", sni)
        .put("utls", JSONObject().put("enabled", true).put("fingerprint", "chrome"))
        .put("reality", JSONObject().put("enabled", true).put("public_key", pbk).put("short_id", sid))

    fun outbounds(item: JSONObject): List<JSONObject> {
        val proto = item.getString("proto")
        val host = item.getString("host"); val port = item.getInt("port")
        fun base(type: String, tag: String = "proxy") = JSONObject().put("type", type).put("tag", tag).put("server", host).put("server_port", port)
        if (proto == "shadowtls") {
            val ss = item.getJSONObject("ss")
            return listOf(
                base("shadowtls", "proxy-tls").put("version", 3).put("password", item.getString("password"))
                    .put("tls", tls(host, item.optString("sni"), false, utls = true)),
                JSONObject().put("type", "shadowsocks").put("tag", "proxy").put("method", ss.getString("method"))
                    .put("password", ss.getString("password")).put("detour", "proxy-tls"),
            )
        }
        val u = Uri.parse(item.getString("uri"))
        fun pr(k: String) = u.getQueryParameter(k) ?: ""
        val ui = u.userInfo ?: ""
        val sni = pr("sni")
        val pbk = pr("pbk"); val sid = pr("sid")
        val insecure = pr("insecure") == "1" || pr("allowInsecure") == "1" || pr("allow_insecure") == "1"
        val o = when (proto) {
            "vless" -> {
                require(pr("type") != "xhttp") { "VLESS XHTTP нужно отдельное ядро (Xray) — пока нет" }
                base("vless").put("uuid", ui).put("packet_encoding", "xudp").apply { if (pr("flow").isNotEmpty()) put("flow", pr("flow")) }
                    .put("tls", JSONObject().put("enabled", true).put("server_name", sni.ifEmpty { host })
                        .put("utls", JSONObject().put("enabled", true).put("fingerprint", "chrome"))
                        .put("reality", JSONObject().put("enabled", true).put("public_key", pbk).put("short_id", sid)))
            }
            "hysteria2" -> base("hysteria2").put("password", ui).put("tls", tls(host, sni, insecure, alpn = true))
                .apply { if (pr("obfs") == "salamander") put("obfs", JSONObject().put("type", "salamander").put("password", pr("obfs-password"))) }
            "tuic" -> {
                val i = ui.indexOf(':')
                base("tuic").put("uuid", if (i < 0) ui else ui.substring(0, i)).put("password", if (i < 0) "" else ui.substring(i + 1))
                    .put("congestion_control", "bbr").put("udp_relay_mode", "native").put("tls", tls(host, sni, insecure, alpn = true))
            }
            "anytls", "trojan" -> base(proto).put("password", ui)
                .put("tls", if (pbk.isNotEmpty()) reality(sni.ifEmpty { host }, pbk, sid) else tls(host, sni, insecure, utls = true))
            "http" -> base("http").apply {
                if (ui.isNotEmpty()) { val i = ui.indexOf(':'); put("username", if (i < 0) ui else ui.substring(0, i)); put("password", if (i < 0) "" else ui.substring(i + 1)) }
                if (u.scheme == "https") put("tls", tls(host, sni, insecure))
            }
            "socks" -> base("socks").put("version", "5").apply {
                if (ui.isNotEmpty()) { val i = ui.indexOf(':'); put("username", if (i < 0) ui else ui.substring(0, i)); put("password", if (i < 0) "" else ui.substring(i + 1)) }
            }
            "shadowsocks" -> {
                val d = String(Base64.decode(ui, Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8)
                val i = d.indexOf(':'); require(i > 0) { "Shadowsocks без метода шифрования" }
                base("shadowsocks").put("method", d.substring(0, i)).put("password", d.substring(i + 1))
            }
            else -> throw IllegalArgumentException("Протокол «$proto» пока нельзя запустить")
        }
        return listOf(o)
    }

    fun singbox(item: JSONObject, ruDirect: Boolean): String {
        val outs = JSONArray(); outbounds(item).forEach { outs.put(it) }
        outs.put(JSONObject().put("type", "direct").put("tag", "direct"))
        val rules = JSONArray()
        if (ruDirect) rules.put(JSONObject().put("domain_suffix", JSONArray(RU)).put("outbound", "direct"))
        return JSONObject()
            .put("log", JSONObject().put("level", "warn"))
            .put("dns", JSONObject().put("servers", JSONArray().put(JSONObject().put("tag", "ru").put("address", "77.88.8.8").put("detour", "direct"))))
            .put("inbounds", JSONArray().put(JSONObject().put("type", "mixed").put("tag", "in").put("listen", "127.0.0.1").put("listen_port", SOCKS_PORT)))
            .put("outbounds", outs)
            .put("route", JSONObject().put("rules", rules).put("final", "proxy"))
            .toString(2)
    }

    /** Туннель hev-socks5-tunnel: TUN → локальный SOCKS5 ядра; имена сайтов решаются на стороне сервера (mapdns). */
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
