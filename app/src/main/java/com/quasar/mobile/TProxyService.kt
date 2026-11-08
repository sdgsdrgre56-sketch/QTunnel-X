package com.quasar.mobile

/** Привязка к hev-socks5-tunnel (библиотека собирается в CI; имя класса задано флагом PKGNAME в jni/Application.mk). */
class TProxyService {
    companion object {
        init { System.loadLibrary("hev-socks5-tunnel") }
        @JvmStatic external fun TProxyStartService(configPath: String, fd: Int)
        @JvmStatic external fun TProxyStopService()
        @JvmStatic external fun TProxyGetStats(): LongArray
    }
}
