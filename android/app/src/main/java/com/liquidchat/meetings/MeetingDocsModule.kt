package com.liquidchat.meetings

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
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
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.FileInputStream

/**
 * Document delivery for meeting minutes:
 *  - renderPdf: HTML -> A4 PDF via an off-screen WebView + print pipeline (no print dialog)
 *  - shareFile: Android share sheet / email compose with the file attached (FileProvider)
 *  - saveToDownloads: copies a file into the public Downloads collection
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

    private fun ReadableMap.str(key: String): String? =
        if (hasKey(key) && !isNull(key)) getString(key) else null

    private fun guessMime(name: String) = when (name.substringAfterLast('.').lowercase()) {
        "pdf" -> "application/pdf"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "md" -> "text/markdown"
        "txt" -> "text/plain"
        "wav" -> "audio/wav"
        else -> "application/octet-stream"
    }
}
