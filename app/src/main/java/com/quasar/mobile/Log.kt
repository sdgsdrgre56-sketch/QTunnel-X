package com.quasar.mobile

import android.os.Handler
import android.os.Looper

object Log {
    private val lines = ArrayDeque<String>()
    @Volatile var listener: ((String) -> Unit)? = null
    private val ui = Handler(Looper.getMainLooper())
    @Synchronized fun add(s: String) {
        lines.addLast(s); while (lines.size > 300) lines.removeFirst()
        val text = lines.joinToString("\n")
        ui.post { listener?.invoke(text) }
    }
    @Synchronized fun text() = lines.joinToString("\n")
}
