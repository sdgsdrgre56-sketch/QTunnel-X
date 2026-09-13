package com.qtunnelx.app

import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

object CryptoBox {
    private val random = SecureRandom()
    private val magic = byteArrayOf('Q'.code.toByte(), 'T'.code.toByte(), 'X'.code.toByte(), '1'.code.toByte())

    fun deriveKey(username: String, password: String): ByteArray {
        val spec = PBEKeySpec(password.toCharArray(), "QTunnelX-v1:$username".toByteArray(), 100_000, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    fun encrypt(username: String, key: ByteArray, plain: ByteArray): ByteArray {
        val user = username.toByteArray(StandardCharsets.UTF_8)
        require(user.size <= 255)
        val nonce = ByteArray(12).also(random::nextBytes)
        val aad = ByteBuffer.allocate(6 + user.size)
            .put(magic).put(1).put(user.size.toByte()).put(user).array()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        val ct = c.doFinal(plain)
        return ByteBuffer.allocate(aad.size + nonce.size + ct.size).put(aad).put(nonce).put(ct).array()
    }

    fun decrypt(username: String, key: ByteArray, frame: ByteArray, len: Int): ByteArray? {
        if (len < 34) return null
        if (!frame.copyOfRange(0, 4).contentEquals(magic) || frame[4].toInt() != 1) return null
        val ul = frame[5].toInt() and 0xff
        if (len < 6 + ul + 12 + 16) return null
        val gotUser = String(frame, 6, ul, StandardCharsets.UTF_8)
        if (gotUser != username) return null
        val aadLen = 6 + ul
        val nonce = frame.copyOfRange(aadLen, aadLen + 12)
        val ct = frame.copyOfRange(aadLen + 12, len)
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            c.updateAAD(frame.copyOfRange(0, aadLen))
            c.doFinal(ct)
        } catch (_: Exception) { null }
    }
}
