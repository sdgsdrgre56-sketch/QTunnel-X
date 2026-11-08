package com.quasar.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/** Держит Квазар живым в фоне и слушает команды «включи/выключи TUN» от него. */
class CoreService : Service() {
    private var ctl: ServerSocket? = null

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel("quasar", "Квазар", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, "quasar").setContentTitle("Квазар работает").setContentText("Нажми, чтобы открыть")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setContentIntent(open).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(1, n)
        if (ctl == null) {
            thread(name = "quasar-ctl") { serve() }
            NodeHost.start(applicationContext)
        }
        return START_STICKY
    }

    private fun serve() {
        try {
            val ss = ServerSocket(NodeHost.CTL_PORT, 8, InetAddress.getByName("127.0.0.1")); ctl = ss
            while (true) {
                val s = ss.accept()
                thread { try {
                    val line = s.getInputStream().bufferedReader().readLine() ?: ""   // GET /tun/start?port=10808 HTTP/1.1
                    val path = line.split(" ").getOrNull(1) ?: ""
                    val port = Regex("port=(\\d+)").find(path)?.groupValues?.get(1) ?: "0"
                    when {
                        path.startsWith("/tun/start") -> startService(Intent(this, QuasarVpn::class.java).setAction(QuasarVpn.ACTION_START).putExtra("port", port.toInt()))
                        path.startsWith("/tun/stop") -> startService(Intent(this, QuasarVpn::class.java).setAction(QuasarVpn.ACTION_STOP))
                    }
                    s.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".toByteArray())
                } catch (_: Throwable) {} finally { try { s.close() } catch (_: Throwable) {} } }
            }
        } catch (_: Throwable) {}
    }
}
