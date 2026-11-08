package com.quasar.mobile

import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import java.io.File

/**
 * TUN-режим: весь трафик телефона идёт в локальный порт ядра Квазара (sing-box) через hev-socks5-tunnel.
 * Само приложение исключено из VPN, поэтому ядра ходят в сеть напрямую, петли нет.
 */
class QuasarVpn : VpnService() {
    companion object {
        const val ACTION_START = "com.quasar.mobile.TUN_START"
        const val ACTION_STOP = "com.quasar.mobile.TUN_STOP"
        @Volatile var running = false
    }
    private var tun: ParcelFileDescriptor? = null
    private var port = 0

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startTun(intent.getIntExtra("port", 10808))
            else -> stopTun()
        }
        return START_NOT_STICKY
    }

    @Synchronized private fun startTun(p: Int) {
        if (running && port == p) return
        stopTun()
        try {
            val b = Builder().setSession("Квазар").setMtu(8500)
                .addAddress("198.18.0.1", 32).addRoute("0.0.0.0", 0).addDnsServer("198.18.0.2")
            b.addDisallowedApplication(packageName)
            val t = b.establish() ?: return
            tun = t; port = p
            val cfg = File(filesDir, "hev.yml").apply { writeText(hev(p)) }
            TProxyService.TProxyStartService(cfg.absolutePath, t.fd)
            running = true
        } catch (e: Throwable) {
            File(filesDir, "data/vpn-error.txt").apply { parentFile?.mkdirs() }.writeText(e.toString())
            stopTun()
        }
    }

    @Synchronized private fun stopTun() {
        if (tun != null) { try { TProxyService.TProxyStopService() } catch (_: Throwable) {} }
        try { tun?.close() } catch (_: Throwable) {}
        tun = null; running = false
    }

    override fun onRevoke() { stopTun(); super.onRevoke() }
    override fun onDestroy() { stopTun(); super.onDestroy() }

    private fun hev(p: Int) = """
tunnel:
  mtu: 8500
  ipv4: 198.18.0.1
socks5:
  port: $p
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
