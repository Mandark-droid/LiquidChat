package com.liquidchat.platform

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File

/**
 * On-disk queue between [LiquidChatNotificationListener] (producer) and
 * NotificationsModule.drain() (consumer): files/notifications/inbox.jsonl, one JSON
 * object per line. Bounded to ~2 MB; oldest lines are dropped first.
 */
object NotificationInbox {

    private const val TAG = "LiquidChatNotif"
    private const val DIR = "notifications"
    private const val FILE = "inbox.jsonl"
    private const val MAX_BYTES = 2L * 1024L * 1024L
    private const val TRIM_TO_BYTES = 3L * 512L * 1024L // 1.5 MB

    private const val PREFS = "liquidchat_notification_filters"
    private const val KEY_ALLOW = "allow"
    private const val KEY_BLOCK = "block"
    private const val KEY_RETENTION_DAYS = "retentionDays"
    private const val DEFAULT_RETENTION_DAYS = 7

    private val lock = Any()

    /** Set by NotificationsModule while a React instance is alive. */
    @Volatile var onPosted: ((JSONObject) -> Unit)? = null

    data class Filters(val allow: Set<String>, val block: Set<String>, val retentionDays: Int)

    // --- Filters ---------------------------------------------------------------

    fun readFilters(context: Context): Filters {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Filters(
            allow = parseSet(p.getString(KEY_ALLOW, null)),
            block = parseSet(p.getString(KEY_BLOCK, null)),
            retentionDays = p.getInt(KEY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
        )
    }

    fun writeFilters(context: Context, allow: List<String>, block: List<String>, retentionDays: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ALLOW, JSONArray(allow).toString())
            .putString(KEY_BLOCK, JSONArray(block).toString())
            .putInt(KEY_RETENTION_DAYS, retentionDays)
            .commit()
    }

    private fun parseSet(raw: String?): Set<String> {
        if (raw == null) return emptySet()
        return try {
            val arr = JSONArray(raw)
            val out = HashSet<String>()
            for (i in 0 until arr.length()) {
                val s = arr.optString(i, "")
                if (s.isNotEmpty()) out.add(s)
            }
            out
        } catch (e: JSONException) {
            emptySet()
        }
    }

    fun isPackageAllowed(filters: Filters, packageName: String): Boolean {
        if (filters.block.contains(packageName)) return false
        if (filters.allow.isNotEmpty() && !filters.allow.contains(packageName)) return false
        return true
    }

    // --- Queue -----------------------------------------------------------------

    private fun file(context: Context): File {
        val dir = File(context.filesDir, DIR)
        if (!dir.exists()) dir.mkdirs()
        return File(dir, FILE)
    }

    fun append(context: Context, entry: JSONObject) {
        synchronized(lock) {
            try {
                val f = file(context)
                f.appendText(entry.toString() + "\n", Charsets.UTF_8)
                if (f.length() > MAX_BYTES) trim(f)
            } catch (e: Exception) {
                Log.w(TAG, "append failed", e)
            }
        }
    }

    /** Keeps the newest lines that fit in TRIM_TO_BYTES. Caller holds [lock]. */
    private fun trim(f: File) {
        val lines = f.readLines(Charsets.UTF_8)
        var total = 0L
        var start = lines.size
        while (start > 0) {
            val len = lines[start - 1].toByteArray(Charsets.UTF_8).size + 1L
            if (total + len > TRIM_TO_BYTES) break
            total += len
            start--
        }
        val kept = lines.subList(start, lines.size)
        val tmp = File(f.parentFile, "$FILE.tmp")
        tmp.writeText(
            if (kept.isEmpty()) "" else kept.joinToString("\n", postfix = "\n"),
            Charsets.UTF_8
        )
        if (!tmp.renameTo(f)) {
            f.writeText(tmp.readText(Charsets.UTF_8), Charsets.UTF_8)
            tmp.delete()
        }
    }

    /**
     * Returns every captured entry not older than retentionDays and empties the file.
     * Corrupt lines are skipped.
     */
    fun drain(context: Context): List<JSONObject> {
        synchronized(lock) {
            val f = file(context)
            if (!f.exists()) return emptyList()
            val retentionDays = readFilters(context).retentionDays
            val cutoff = if (retentionDays > 0) {
                System.currentTimeMillis() - retentionDays * 24L * 60L * 60L * 1000L
            } else {
                Long.MIN_VALUE
            }
            val out = ArrayList<JSONObject>()
            try {
                for (line in f.readLines(Charsets.UTF_8)) {
                    if (line.isBlank()) continue
                    try {
                        val o = JSONObject(line)
                        if (o.optLong("postedAt", 0L) >= cutoff) out.add(o)
                    } catch (e: JSONException) {
                        // skip
                    }
                }
            } finally {
                f.writeText("", Charsets.UTF_8)
            }
            return out
        }
    }

    // --- Redaction -------------------------------------------------------------

    private val KEYWORD = Regex(
        "(?i)(otp|one[ -]?time|passcode|password|passwd|\\bpin\\b|verification|verify|security code|code|पासवर्ड|ओटीपी|सत्यापन|कोड)"
    )
    private val DIGITS = Regex("(?<!\\d)(\\d{4,8}|\\d{3}[ -]\\d{3})(?!\\d)")
    private val AFTER_OTP = Regex("(?i)(\\bOTP\\b|ओटीपी)")
    private const val WINDOW = 40
    const val REDACTED = "[REDACTED]"

    /**
     * Removes one-time codes: 4-8 digit numbers (or "123 456") within ~40 chars of an
     * OTP/code/password keyword, and everything that follows the word "OTP".
     */
    fun redact(input: String): String {
        if (input.isEmpty()) return input
        var text = input

        val keywords = KEYWORD.findAll(text).map { it.range }.toList()
        if (keywords.isNotEmpty()) {
            val sb = StringBuilder()
            var last = 0
            for (m in DIGITS.findAll(text)) {
                val r = m.range
                val near = keywords.any { k ->
                    val gap = if (r.first > k.last) r.first - k.last else k.first - r.last
                    gap <= WINDOW
                }
                if (near) {
                    sb.append(text, last, r.first).append(REDACTED)
                    last = r.last + 1
                }
            }
            sb.append(text, last, text.length)
            text = sb.toString()
        }

        val otp = AFTER_OTP.find(text)
        if (otp != null) {
            val end = otp.range.last + 1
            if (end < text.length) text = text.substring(0, end) + " " + REDACTED
        }
        return text
    }
}
