package com.quasar.mobile

import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

/**
 * Та же схема, что у Квазара на ПК: ядро (mihomo) даёт локальный SOCKS5, а режим TUN поднимает туннель к нему.
 * Само приложение исключено из VPN, поэтому исходящие соединения ядра идут мимо туннеля и петли нет.
 */
class QuasarVpn : VpnService() {
    companion object {
        const val ACTION_STOP = "com.quasar.mobile.STOP"
        @Volatile var running = false
    }

    private var tun: ParcelFileDescriptor? = null
    private var proc: Process? = null
    @Volatile private var starting = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopAll(); stopSelf(); return START_NOT_STICKY }
        if (starting || running) return START_NOT_STICKY
        val p = Store.load(this)
        if (p == null) { Log.add("Нет профиля Sudoku"); stopSelf(); return START_NOT_STICKY }
        starting = true
        thread(name = "quasar-start") {
            try { start(p) } catch (e: Throwable) { Log.add("Ошибка запуска: ${e.message}"); stopAll(); stopSelf() }
            starting = false
        }
        return START_NOT_STICKY
    }

    private fun start(p: Profile) {
        val dir = File(filesDir, "mihomo").apply { mkdirs() }
        val cfg = File(dir, "config.yaml").apply { writeText(Cfg.mihomo(p, Store.ruDirect(this@QuasarVpn))) }
        val exe = File(applicationInfo.nativeLibraryDir, "libmihomo.so")
        if (!exe.exists()) throw IllegalStateException("в APK нет ядра mihomo (libmihomo.so)")
        Log.add("Запускаю ядро mihomo → ${p.host}:${p.port}")
        proc = ProcessBuilder(exe.absolutePath, "-d", dir.absolutePath, "-f", cfg.absolutePath)
            .redirectErrorStream(true).start()
        val pr = proc!!
        thread(name = "mihomo-log") {
            try { pr.inputStream.bufferedReader().forEachLine { Log.add(it.take(300)) } } catch (_: Throwable) {}
        }
        // ждём, пока откроется локальный порт ядра
        var ok = false
        for (i in 0 until 40) {
            if (!pr.isAlive) throw IllegalStateException("ядро сразу закрылось (код ${pr.exitValue()}), смотри журнал выше")
            try { Socket().use { it.connect(InetSocketAddress("127.0.0.1", Cfg.SOCKS_PORT), 200) }; ok = true; break } catch (_: Throwable) { Thread.sleep(250) }
        }
        if (!ok) throw IllegalStateException("ядро не открыло порт ${Cfg.SOCKS_PORT}")

        val b = Builder().setSession("Квазар").setMtu(8500)
            .addAddress("198.18.0.1", 32).addRoute("0.0.0.0", 0).addDnsServer("198.18.0.2")
        b.addDisallowedApplication(packageName)
        val t = b.establish() ?: throw IllegalStateException("Android не создал VPN (нет разрешения?)")
        tun = t
        val hevCfg = File(filesDir, "hev.yml").apply { writeText(Cfg.hev()) }
        TProxyService.TProxyStartService(hevCfg.absolutePath, t.fd)
        running = true
        Log.add("Туннель включён (TUN). Весь трафик телефона идёт через Sudoku.")
    }

    private fun stopAll() {
        running = false
        try { TProxyService.TProxyStopService() } catch (_: Throwable) {}
        try { tun?.close() } catch (_: Throwable) {}
        tun = null
        proc?.destroy(); proc = null
        Log.add("Отключено")
    }

    override fun onRevoke() { stopAll(); super.onRevoke() }
    override fun onDestroy() { stopAll(); super.onDestroy() }
}
