package com.liquidchat.meetings

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.print.PdfPrintBridge
import android.print.PrintAttributes
import android.provider.MediaStore
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.FileInputStream

/**
 * Document delivery for meeting minutes:
 *  - renderPdf: HTML -> A4 PDF via an off-screen WebView + print pipeline (no print dialog)
 *  - shareFile: Android share sheet / email compose with the file attached (FileProvider)
 *  - saveToDownloads: copies a file into the public Downloads collection
 *  - encodeAudio: joins the meeting's 16 kHz WAV segments into one AAC .m4a for other tools
 */
class MeetingDocsModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "MeetingDocs"

    private val main = Handler(Looper.getMainLooper())
    // Strong refs so in-flight WebViews are not garbage-collected mid-render.
    private val active = mutableSetOf<WebView>()

    @SuppressLint("SetJavaScriptEnabled")
    @ReactMethod
    fun renderPdf(html: String, outPath: String, promise: Promise) {
        val out = File(outPath.removePrefix("file://"))
        out.parentFile?.mkdirs()
        main.post {
            try {
                val wv = WebView(ctx)
                active.add(wv)
                wv.settings.javaScriptEnabled = false
                wv.settings.allowFileAccess = false
                var finished = false
                wv.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String?) {
                        if (finished) return
                        finished = true
                        try {
                            val adapter = view.createPrintDocumentAdapter("Minutes")
                            val attrs = PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                .setResolution(PrintAttributes.Resolution("pdf", "pdf", 300, 300))
                                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                                .build()
                            val pfd = ParcelFileDescriptor.open(
                                out,
                                ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE or
                                    ParcelFileDescriptor.MODE_READ_WRITE
                            )
                            PdfPrintBridge.print(adapter, attrs, pfd) { ok, err ->
                                runCatching { pfd.close() }
                                main.post { active.remove(view); view.destroy() }
                                if (ok) promise.resolve(out.absolutePath)
                                else promise.reject("PDF_FAILED", err ?: "unknown")
                            }
                        } catch (e: Throwable) {
                            active.remove(view); view.destroy()
                            promise.reject("PDF_FAILED", e.message, e)
                        }
                    }
                }
                wv.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            } catch (e: Throwable) {
                promise.reject("PDF_FAILED", e.message, e)
            }
        }
    }

    /**
     * opts: { mime?, subject?, text?, emails?: string[], chooserTitle?, emailOnly?: boolean }
     */
    @ReactMethod
    fun shareFile(path: String, opts: ReadableMap, promise: Promise) {
        try {
            val file = File(path.removePrefix("file://"))
            if (!file.exists()) { promise.reject("NOT_FOUND", "File not found: $path"); return }
            val uri: Uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
            val mime = opts.str("mime") ?: guessMime(file.name)
            val emailOnly = opts.hasKey("emailOnly") && opts.getBoolean("emailOnly")

            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                opts.str("subject")?.let { putExtra(Intent.EXTRA_SUBJECT, it) }
                opts.str("text")?.let { putExtra(Intent.EXTRA_TEXT, it) }
                if (opts.hasKey("emails")) {
                    val arr = opts.getArray("emails")
                    val emails = (0 until (arr?.size() ?: 0)).mapNotNull { arr?.getString(it) }
                    if (emails.isNotEmpty()) putExtra(Intent.EXTRA_EMAIL, emails.toTypedArray())
                }
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                if (emailOnly) selector = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"))
            }
            val chooser = Intent.createChooser(send, opts.str("chooserTitle") ?: "Share minutes").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val activity = ctx.currentActivity
            if (activity != null) activity.startActivity(chooser) else ctx.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("SHARE_FAILED", e.message, e)
        }
    }

    /** Returns a content:// URI (Android 10+) or absolute path of the saved copy. */
    @Suppress("DEPRECATION")
    @ReactMethod
    fun saveToDownloads(path: String, displayName: String, mime: String, promise: Promise) {
        try {
            val src = File(path.removePrefix("file://"))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, displayName)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/LiquidChat")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = ctx.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("MediaStore insert failed")
                resolver.openOutputStream(uri)!!.use { os -> FileInputStream(src).use { it.copyTo(os) } }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                promise.resolve(uri.toString())
            } else {
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "LiquidChat")
                dir.mkdirs()
                val dest = File(dir, displayName)
                src.copyTo(dest, overwrite = true)
                promise.resolve(dest.absolutePath)
            }
        } catch (e: Throwable) {
            promise.reject("SAVE_FAILED", e.message, e)
        }
    }

    /** wavPaths: 16 kHz mono PCM16 segments (44-byte header), in order. Resolves the .m4a path. */
    @ReactMethod
    fun encodeAudio(wavPaths: ReadableArray, outPath: String, promise: Promise) {
        val paths = (0 until wavPaths.size()).mapNotNull { wavPaths.getString(it)?.removePrefix("file://") }
        val out = File(outPath.removePrefix("file://"))
        Thread {
            try {
                out.parentFile?.mkdirs()
                encodeM4a(paths, out)
                promise.resolve(out.absolutePath)
            } catch (e: Throwable) {
                out.delete()
                promise.reject("ENCODE_FAILED", e.message, e)
            }
        }.start()
    }

    private fun encodeM4a(paths: List<String>, out: File) {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, WAV_RATE, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 48_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        val muxer = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var muxing = false
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val files = paths.map(::File).filter { it.length() > WAV_HEADER }.iterator()
            // Whole segments are small (~1 MB); reading each at once keeps samples 2-byte aligned.
            var pcm = ByteArray(0)
            var pos = 0
            var samples = 0L
            var track = -1
            var inputDone = false
            val info = MediaCodec.BufferInfo()
            while (true) {
                if (!inputDone) {
                    val ix = codec.dequeueInputBuffer(5_000)
                    if (ix >= 0) {
                        while (pos >= pcm.size && files.hasNext()) {
                            pcm = files.next().readBytes()
                            pos = WAV_HEADER
                        }
                        val ptsUs = samples * 1_000_000L / WAV_RATE
                        if (pos >= pcm.size) {
                            codec.queueInputBuffer(ix, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            val buf = codec.getInputBuffer(ix)!!
                            buf.clear()
                            val n = minOf(buf.remaining(), pcm.size - pos) and 1.inv()
                            buf.put(pcm, pos, n)
                            pos += maxOf(n, 1)
                            samples += n / 2
                            codec.queueInputBuffer(ix, 0, n, ptsUs, 0)
                        }
                    }
                }
                // Drain every finished frame; waiting on one per pass stalls the encoder.
                var ended = false
                while (true) {
                    val ox = codec.dequeueOutputBuffer(info, if (inputDone) 10_000 else 0)
                    if (ox == MediaCodec.INFO_TRY_AGAIN_LATER) break
                    if (ox == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                        muxing = true
                    } else if (ox >= 0) {
                        val buf = codec.getOutputBuffer(ox)!!
                        val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                        if (muxing && !config && info.size > 0) {
                            buf.position(info.offset)
                            buf.limit(info.offset + info.size)
                            muxer.writeSampleData(track, buf, info)
                        }
                        codec.releaseOutputBuffer(ox, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                            ended = true
                            break
                        }
                    }
                }
                if (ended) break
            }
            if (samples == 0L) throw IllegalStateException("No audio to export")
        } finally {
            runCatching { codec.stop() }
            codec.release()
            if (muxing) runCatching { muxer.stop() }
            muxer.release()
        }
    }

    private fun ReadableMap.str(key: String): String? =
        if (hasKey(key) && !isNull(key)) getString(key) else null

    private fun guessMime(name: String) = when (name.substringAfterLast('.').lowercase()) {
        "pdf" -> "application/pdf"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "md" -> "text/markdown"
        "txt" -> "text/plain"
        "wav" -> "audio/wav"
        "m4a" -> "audio/mp4"
        else -> "application/octet-stream"
    }

    private companion object {
        const val WAV_RATE = 16_000
        const val WAV_HEADER = 44
    }
}
