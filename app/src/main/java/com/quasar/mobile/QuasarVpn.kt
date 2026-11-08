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
        val p = Store.selected(this)
        if (p == null) { Log.add("Не выбран протокол"); stopSelf(); return START_NOT_STICKY }
        starting = true
        thread(name = "quasar-start") {
            try { start(p) } catch (e: Throwable) { Log.add("Ошибка запуска: ${e.message}"); stopAll(); stopSelf() }
            starting = false
        }
        return START_NOT_STICKY
    }

    private fun start(p: org.json.JSONObject) {
        val proto = p.getString("proto")
        val core = Protos.core(proto) ?: throw IllegalStateException("Протокол «$proto» пока не поддерживается")
        val ru = Store.ruDirect(this)
        val dir = File(filesDir, core).apply { mkdirs() }
        val args: List<String>
        val exeName: String
        if (core == "mihomo") {
            val cfg = File(dir, "config.yaml").apply { writeText(Cfg.mihomo(p, ru)) }
            exeName = "libmihomo.so"; args = listOf("-d", dir.absolutePath, "-f", cfg.absolutePath)
        } else {
            val cfg = File(dir, "config.json").apply { writeText(Cfg.singbox(p, ru)) }
            exeName = "libsingbox.so"; args = listOf("run", "-c", cfg.absolutePath, "-D", dir.absolutePath)
        }
        val exe = File(applicationInfo.nativeLibraryDir, exeName)
        if (!exe.exists()) throw IllegalStateException("в APK нет ядра $core ($exeName)")
        Log.add("Запускаю ядро $core: ${Protos.title(p)}")
        proc = ProcessBuilder(listOf(exe.absolutePath) + args).redirectErrorStream(true).apply { environment()["HOME"] = dir.absolutePath }.start()
        val pr = proc!!
        thread(name = "core-log") {
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
        Log.add("Туннель включён (TUN). Весь трафик телефона идёт через выбранный протокол.")
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
