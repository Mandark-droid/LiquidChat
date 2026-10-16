package com.liquidchat.platform

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets for the agent runtime (src/platform/types.ts: CredentialStore).
 *
 * Values are encrypted with an AES-256-GCM key that never leaves the Android
 * Keystore (alias "liquidchat_credentials") and stored as base64(iv || ciphertext+tag)
 * in a private SharedPreferences file. No androidx.security dependency.
 *
 * Error codes: KEYSTORE_UNAVAILABLE (key cannot be created/loaded),
 * DECRYPT_FAILED (value unreadable, e.g. key invalidated after a lock-screen reset),
 * CREDENTIAL_ERROR (anything else).
 */
class CredentialStoreModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "CredentialStore"

    private val prefs: SharedPreferences
        get() = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @ReactMethod
    fun get(key: String, promise: Promise) {
        try {
            val stored = prefs.getString(VALUE_PREFIX + key, null)
            if (stored == null) {
                promise.resolve(null)
                return
            }
            promise.resolve(decrypt(stored))
        } catch (e: KeystoreException) {
            promise.reject("KEYSTORE_UNAVAILABLE", e.message, e)
        } catch (e: GeneralSecurityException) {
            promise.reject("DECRYPT_FAILED", "Could not decrypt credential '$key': ${e.message}", e)
        } catch (e: Exception) {
            promise.reject("CREDENTIAL_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun set(key: String, value: String, promise: Promise) {
        try {
            val encrypted = encrypt(value)
            if (!prefs.edit().putString(VALUE_PREFIX + key, encrypted).commit()) {
                promise.reject("CREDENTIAL_ERROR", "Failed to persist credential '$key'")
                return
            }
            promise.resolve(null)
        } catch (e: KeystoreException) {
            promise.reject("KEYSTORE_UNAVAILABLE", e.message, e)
        } catch (e: GeneralSecurityException) {
            promise.reject("ENCRYPT_FAILED", e.message, e)
        } catch (e: Exception) {
            promise.reject("CREDENTIAL_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun delete(key: String, promise: Promise) {
        try {
            prefs.edit().remove(VALUE_PREFIX + key).commit()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("CREDENTIAL_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun has(key: String, promise: Promise) {
        try {
            promise.resolve(prefs.contains(VALUE_PREFIX + key))
        } catch (e: Exception) {
            promise.reject("CREDENTIAL_ERROR", e.message, e)
        }
    }

    /** 32 random bytes, created once, stored wrapped by the Keystore key; resolves lowercase hex. */
    @ReactMethod
    fun databaseKey(promise: Promise) {
        try {
            synchronized(LOCK) {
                val stored = prefs.getString(DB_KEY_PREF, null)
                if (stored != null) {
                    promise.resolve(decrypt(stored))
                    return
                }
                val bytes = ByteArray(32)
                SecureRandom().nextBytes(bytes)
                val hex = toHex(bytes)
                bytes.fill(0)
                if (!prefs.edit().putString(DB_KEY_PREF, encrypt(hex)).commit()) {
                    promise.reject("CREDENTIAL_ERROR", "Failed to persist database key")
                    return
                }
                promise.resolve(hex)
            }
        } catch (e: KeystoreException) {
            promise.reject("KEYSTORE_UNAVAILABLE", e.message, e)
        } catch (e: GeneralSecurityException) {
            // Never silently regenerate: that would orphan the encrypted database.
            promise.reject("DECRYPT_FAILED", "Database key cannot be unwrapped: ${e.message}", e)
        } catch (e: Exception) {
            promise.reject("CREDENTIAL_ERROR", e.message, e)
        }
    }

    // --- Crypto --------------------------------------------------------------

    private class KeystoreException(message: String, cause: Throwable?) : Exception(message, cause)

    private fun secretKey(): SecretKey {
        try {
            val ks = KeyStore.getInstance(ANDROID_KEYSTORE)
            ks.load(null)
            val existing = ks.getKey(KEY_ALIAS, null)
            if (existing is SecretKey) return existing

            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            val spec = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
            generator.init(spec)
            return generator.generateKey()
        } catch (e: Exception) {
            throw KeystoreException("Android Keystore unavailable: ${e.message}", e)
        }
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val out = ByteArray(iv.size + ct.size)
        System.arraycopy(iv, 0, out, 0, iv.size)
        System.arraycopy(ct, 0, out, iv.size, ct.size)
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val raw = try {
            Base64.decode(stored, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            throw GeneralSecurityException("Corrupt credential encoding", e)
        }
        if (raw.size <= IV_BYTES) throw GeneralSecurityException("Credential too short")
        val key = secretKey()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES))
        val plain = cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES)
        return String(plain, Charsets.UTF_8)
    }

    private fun toHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            sb.append(HEX[v ushr 4])
            sb.append(HEX[v and 0x0F])
        }
        return sb.toString()
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "liquidchat_credentials"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private const val PREFS = "liquidchat_credentials"
        private const val VALUE_PREFIX = "v:"
        private const val DB_KEY_PREF = "__database_key__"
        private const val HEX = "0123456789abcdef"
        private val LOCK = Any()
    }
}
