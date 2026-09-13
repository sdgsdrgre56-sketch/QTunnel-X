package com.qtunnelx.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class TunnelConfig(
    val server: String = "",
    val port: Int = 46000,
    val username: String = "",
    val password: String = "",
    val clientIp: String = "10.44.0.2",
    val dns: String = "1.1.1.1",
    val uploadMbps: Double = 0.0,
    val downloadMbps: Double = 0.0
)

data class SavedProfile(val name: String, val config: TunnelConfig)

class ConfigStore(context: Context) {
    private val p = context.getSharedPreferences("qtunnelx", Context.MODE_PRIVATE)

    fun load(): TunnelConfig = TunnelConfig(
        p.getString("server", "") ?: "",
        p.getInt("port", 46000),
        p.getString("username", "") ?: "",
        p.getString("password", "") ?: "",
        p.getString("clientIp", "10.44.0.2") ?: "10.44.0.2",
        p.getString("dns", "1.1.1.1") ?: "1.1.1.1",
        java.lang.Double.longBitsToDouble(p.getLong("uploadMbps", java.lang.Double.doubleToRawLongBits(0.0))),
        java.lang.Double.longBitsToDouble(p.getLong("downloadMbps", java.lang.Double.doubleToRawLongBits(0.0)))
    )

    fun save(c: TunnelConfig) {
        p.edit().putString("server", c.server).putInt("port", c.port)
            .putString("username", c.username).putString("password", c.password)
            .putString("clientIp", c.clientIp).putString("dns", c.dns)
            .putLong("uploadMbps", java.lang.Double.doubleToRawLongBits(c.uploadMbps))
            .putLong("downloadMbps", java.lang.Double.doubleToRawLongBits(c.downloadMbps)).apply()
    }

    fun hashes(): List<String> = (0 until 10).map { p.getString("hash_$it", "") ?: "" }
    fun saveHashes(v: List<String>) {
        val e = p.edit(); for (i in 0 until 10) e.putString("hash_$i", v.getOrElse(i) { "" }); e.apply()
    }

    fun profiles(): MutableList<SavedProfile> {
        return try {
            val a = JSONArray(p.getString("profiles", "[]"))
            MutableList(a.length()) { i ->
                val o = a.getJSONObject(i)
                SavedProfile(o.getString("name"), TunnelConfig(
                    o.getString("server"), o.getInt("port"), o.getString("username"),
                    o.getString("password"), o.getString("clientIp"), o.getString("dns"),
                    o.optDouble("uploadMbps", 0.0), o.optDouble("downloadMbps", 0.0)
                ))
            }
        } catch (_: Exception) { mutableListOf() }
    }

    fun saveProfiles(items: List<SavedProfile>) {
        val a = JSONArray()
        items.forEach { item ->
            val c = item.config
            a.put(JSONObject().put("name", item.name).put("server", c.server).put("port", c.port)
                .put("username", c.username).put("password", c.password)
                .put("clientIp", c.clientIp).put("dns", c.dns)
                .put("uploadMbps", c.uploadMbps).put("downloadMbps", c.downloadMbps))
        }
        p.edit().putString("profiles", a.toString()).apply()
    }
}
