package com.quasar.mobile

import android.content.Context
import java.io.File

object NodeHost {
    const val PORT = 18765      // порт интерфейса Квазара (127.0.0.1)
    const val CTL_PORT = 18790  // порт, по которому Квазар просит приложение включить/выключить TUN
    @Volatile private var started = false

    fun dataDir(c: Context) = File(c.filesDir, "data")
    fun instanceFile(c: Context) = File(dataDir(c), "instance.json")

    @Synchronized fun start(c: Context) {
        if (started) return
        started = true
        val project = File(c.filesDir, "nodejs-project")
        val stamp = File(c.filesDir, "nodejs-project.stamp")
        val ver = c.packageManager.getPackageInfo(c.packageName, 0).lastUpdateTime.toString()
        if (!project.exists() || !stamp.exists() || stamp.readText() != ver) {
            project.deleteRecursively()
            copyAssets(c, "nodejs-project", project)
            stamp.writeText(ver)
        }
        dataDir(c).mkdirs()
        instanceFile(c).delete()   // старый адрес не должен попасть в окно
        NativeNode.setEnv("QUASAR_DATA", dataDir(c).absolutePath)
        NativeNode.setEnv("QUASAR_NATIVE_DIR", c.applicationInfo.nativeLibraryDir)
        NativeNode.setEnv("QUASAR_CTL", CTL_PORT.toString())
        NativeNode.setEnv("QUASAR_PORT", PORT.toString())
        NativeNode.setEnv("HOME", c.filesDir.absolutePath)
        NativeNode.setEnv("TMPDIR", c.cacheDir.absolutePath)
        Thread(null, {
            val code = NativeNode.startNode(arrayOf("node", File(project, "main.js").absolutePath))
            File(dataDir(c), "node-exit.txt").writeText("Node завершился с кодом $code")
        }, "node", 4L * 1024 * 1024).start()
    }

    private fun copyAssets(c: Context, path: String, dst: File) {
        val list = c.assets.list(path) ?: emptyArray()
        if (list.isEmpty()) {   // файл
            dst.parentFile?.mkdirs()
            c.assets.open(path).use { i -> dst.outputStream().use { o -> i.copyTo(o) } }
        } else {
            dst.mkdirs()
            for (n in list) copyAssets(c, "$path/$n", File(dst, n))
        }
    }
}
