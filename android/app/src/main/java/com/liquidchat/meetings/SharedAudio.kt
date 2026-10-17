package com.liquidchat.meetings

import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import java.io.File

/**
 * Audio shared into LiquidChat (Share / Open with) from apps whose files the SAF picker can't
 * reach, e.g. a recorder that keeps recordings in private storage. The sender's read grant
 * lasts only as long as the receiving activity, so each file is copied to the cache at once
 * and JS consumes the copies via MeetingRecorder.consumeSharedAudio().
 */
object SharedAudio {
    data class Item(
        val uri: String,
        val name: String,
        val size: Double,
        val durationMs: Double,
        val mime: String?,
    )

    private const val TAG = "LiquidChatShare"
    private const val MAX_AGE_MS = 24L * 60 * 60 * 1000
    private val AUDIO_EXT = setOf(
        "aac", "m4a", "mp3", "wav", "ogg", "oga", "opus", "amr", "awb", "3gp", "3ga",
        "flac", "mp4", "m4b", "webm", "mkv", "wma",
    )

    private val pending = mutableListOf<Item>()

    /** Set by MeetingRecorderModule so a running JS runtime hears about warm shares. */
    @Volatile var onCaptured: (() -> Unit)? = null

    /** Called from MainActivity.onCreate / onNewIntent. Clears the intent so it is read once. */
    fun capture(context: Context, intent: Intent?) {
        if (intent == null) return
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(streamExtra(intent)).ifEmpty { clipUris(intent) }
            Intent.ACTION_SEND_MULTIPLE -> streamListExtra(intent).ifEmpty { clipUris(intent) }
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            else -> emptyList()
        }
        if (uris.isEmpty()) return
        val declaredType = intent.type
        intent.action = Intent.ACTION_MAIN
        intent.removeExtra(Intent.EXTRA_STREAM)
        intent.data = null

        val app = context.applicationContext
        Thread({
            val dir = File(app.cacheDir, "shared").apply { mkdirs() }
            dir.listFiles()?.forEach {
                if (System.currentTimeMillis() - it.lastModified() > MAX_AGE_MS) it.delete()
            }
            val items = uris.mapNotNull { uri ->
                runCatching { copy(app, uri, declaredType, dir) }
                    .onFailure { Log.w(TAG, "could not read shared $uri", it) }
                    .getOrNull()
            }
            if (items.isEmpty()) return@Thread
            synchronized(this) { pending += items }
            onCaptured?.invoke()
        }, "SharedAudioCopy").start()
    }

    fun consume(): List<Item> = synchronized(this) {
        val out = pending.toList()
        pending.clear()
        out
    }

    private fun copy(context: Context, uri: Uri, declaredType: String?, dir: File): Item? {
        val resolver = context.contentResolver
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "Recording"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (c.moveToFirst() && n >= 0 && !c.isNull(n)) name = c.getString(n)
        }
        val mime = resolver.getType(uri) ?: declaredType
        val ext = name.substringAfterLast('.', "").lowercase()
        val looksAudio = mime?.startsWith("audio/") == true || mime?.startsWith("video/") == true ||
            mime == "application/ogg" || ext in AUDIO_EXT
        if (!looksAudio) {
            Log.i(TAG, "ignoring non-audio share $name ($mime)")
            return null
        }
        val safe = name.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(120).ifBlank { "recording" }
        val out = File(dir, "${System.currentTimeMillis()}_$safe")
        resolver.openInputStream(uri)?.use { input ->
            out.outputStream().use { input.copyTo(it, 1 shl 16) }
        } ?: return null
        var durationMs = 0.0
        runCatching {
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(out.absolutePath)
                durationMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                    ?.toDoubleOrNull() ?: 0.0
            } finally {
                r.release()
            }
        }
        return Item(Uri.fromFile(out).toString(), name, out.length().toDouble(), durationMs, mime)
    }

    @Suppress("DEPRECATION")
    private fun streamExtra(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun streamListExtra(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()

    private fun clipUris(intent: Intent): List<Uri> {
        val clip = intent.clipData ?: return emptyList()
        return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    }
}
