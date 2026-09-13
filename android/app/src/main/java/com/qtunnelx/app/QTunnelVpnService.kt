package com.qtunnelx.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

class QTunnelVpnService : VpnService() {
    private var tun: ParcelFileDescriptor? = null
    private var socket: DatagramSocket? = null
    private val running = AtomicBoolean(false)

    companion object {
        const val ACTION_START = "com.qtunnelx.START"
        const val ACTION_STOP = "com.qtunnelx.STOP"

        @Volatile var connected = false
        @Volatile var status = "Отключено"
        @Volatile var pingMs = -1L
        @Volatile var lastPongMs = 0L
        val txBytes = AtomicLong(0)
        val rxBytes = AtomicLong(0)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopTunnel()
            return START_NOT_STICKY
        }
        if (running.compareAndSet(false, true)) {
            startForegroundCompat()
            thread(name = "qtx-supervisor") { supervisorLoop() }
        }
        return START_STICKY
    }

    private fun supervisorLoop() {
        while (running.get()) {
            try {
                runSession()
            } catch (e: Exception) {
                connected = false
                pingMs = -1
                if (running.get()) {
                    status = "Переподключение: ${e.message ?: e.javaClass.simpleName}"
                    cleanupSession()
                    try { Thread.sleep(2500) } catch (_: InterruptedException) {}
                }
            }
        }
        cleanupSession()
    }

    private fun runSession() {
        val c = ConfigStore(this).load()
        require(c.server.isNotBlank()) { "Не указан сервер" }
        require(c.username.isNotBlank()) { "Не указан логин" }
        require(c.password.isNotBlank()) { "Не указан пароль" }
        require(c.clientIp.startsWith("10.44.0.")) { "Неверный IP клиента" }

        status = "Проверка сервера…"
        val key = CryptoBox.deriveKey(c.username, c.password)
        val serverAddress = InetAddress.getByName(c.server)

        val udp = DatagramSocket()
        if (!protect(udp)) error("Не удалось исключить UDP-сокет из VPN")
        udp.connect(serverAddress, c.port)
        udp.soTimeout = 1000
        socket = udp

        // Authenticate BEFORE creating the Android TUN.  Wrong credentials therefore
        // cannot black-hole the phone's normal Internet connection.
        val authPing = ByteBuffer.allocate(9).put(1).putLong(System.currentTimeMillis()).array()
        var authenticated = false
        for (attempt in 0 until 4) {
            val enc = CryptoBox.encrypt(c.username, key, authPing)
            udp.send(DatagramPacket(enc, enc.size))
            val buf = ByteArray(4096)
            val dp = DatagramPacket(buf, buf.size)
            try {
                udp.receive(dp)
                val plain = CryptoBox.decrypt(c.username, key, dp.data, dp.length)
                if (plain != null && plain.size == 9 && plain[0].toInt() == 2) {
                    authenticated = true
                    break
                }
            } catch (_: SocketTimeoutException) {
                // retry
            }
        }
        if (!authenticated) error("Сервер не ответил или неверный логин/пароль")

        status = "Создание VPN…"
        udp.soTimeout = 1200
        val pfd = Builder()
            .setSession("QTunnel X")
            .setMtu(1280)
            .addAddress(c.clientIp, 24)
            .addRoute("0.0.0.0", 0)
            .addDnsServer(c.dns)
            .establish() ?: error("Не удалось создать TUN")
        tun = pfd

        val input = FileInputStream(pfd.fileDescriptor)
        val output = FileOutputStream(pfd.fileDescriptor)

        connected = true
        status = "Подключено"
        txBytes.set(0)
        rxBytes.set(0)
        lastPongMs = System.currentTimeMillis()

        val sessionAlive = AtomicBoolean(true)

        val up = thread(name = "qtx-tun-to-udp") {
            val buf = ByteArray(1280)
            try {
                while (running.get() && sessionAlive.get()) {
                    val n = input.read(buf)
                    if (n <= 0) continue
                    val plain = ByteArray(n + 1)
                    plain[0] = 0
                    System.arraycopy(buf, 0, plain, 1, n)
                    val enc = CryptoBox.encrypt(c.username, key, plain)
                    udp.send(DatagramPacket(enc, enc.size))
                    txBytes.addAndGet(n.toLong())
                }
            } catch (_: Exception) {
                sessionAlive.set(false)
            }
        }

        val down = thread(name = "qtx-udp-to-tun") {
            val buf = ByteArray(4096)
            try {
                while (running.get() && sessionAlive.get()) {
                    val dp = DatagramPacket(buf, buf.size)
                    try {
                        udp.receive(dp)
                    } catch (_: SocketTimeoutException) {
                        continue
                    }
                    val plain = CryptoBox.decrypt(c.username, key, dp.data, dp.length) ?: continue
                    if (plain.isEmpty()) continue
                    when (plain[0].toInt()) {
                        0 -> if (plain.size > 1) {
                            output.write(plain, 1, plain.size - 1)
                            output.flush()
                            rxBytes.addAndGet((plain.size - 1).toLong())
                        }
                        2 -> if (plain.size == 9) {
                            val sent = ByteBuffer.wrap(plain, 1, 8).long
                            lastPongMs = System.currentTimeMillis()
                            pingMs = (lastPongMs - sent).coerceAtLeast(0)
                        }
                    }
                }
            } catch (_: Exception) {
                sessionAlive.set(false)
            }
        }

        val keepAlive = thread(name = "qtx-keepalive") {
            try {
                while (running.get() && sessionAlive.get()) {
                    val now = System.currentTimeMillis()
                    val b = ByteBuffer.allocate(9).put(1).putLong(now).array()
                    val enc = CryptoBox.encrypt(c.username, key, b)
                    udp.send(DatagramPacket(enc, enc.size))

                    if (now - lastPongMs > 15_000) {
                        status = "Связь потеряна…"
                        sessionAlive.set(false)
                        udp.close()
                        break
                    }
                    Thread.sleep(5000)
                }
            } catch (_: Exception) {
                sessionAlive.set(false)
            }
        }

        while (running.get() && sessionAlive.get()) {
            Thread.sleep(250)
        }

        connected = false
        cleanupSession()
        if (running.get()) error("Соединение потеряно")
    }

    private fun startForegroundCompat() {
        val channelId = "qtunnelx_vpn"
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(channelId, "QTunnel X VPN", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        val notification = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
            .setContentTitle("QTunnel X")
            .setContentText("Защищённый туннель")
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentIntent(open)
            .setOngoing(true)
            .build()

        startForeground(1001, notification)
    }

    @Synchronized
    private fun cleanupSession() {
        connected = false
        try { socket?.close() } catch (_: Exception) {}
        try { tun?.close() } catch (_: Exception) {}
        socket = null
        tun = null
        pingMs = -1
    }

    @Synchronized
    private fun stopTunnel() {
        running.set(false)
        cleanupSession()
        status = "Отключено"
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running.set(false)
        cleanupSession()
        super.onDestroy()
    }
}
