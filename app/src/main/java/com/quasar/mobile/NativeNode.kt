package com.quasar.mobile

/** Node.js (nodejs-mobile) внутри приложения: ПК-Квазар запускается как есть. */
class NativeNode {
    companion object {
        init { System.loadLibrary("node"); System.loadLibrary("native-lib") }
        @JvmStatic external fun setEnv(k: String, v: String)
        @JvmStatic external fun startNode(args: Array<String>): Int
    }
}
