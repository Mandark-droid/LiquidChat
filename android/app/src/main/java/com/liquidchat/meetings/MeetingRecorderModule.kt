package com.liquidchat.meetings

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * JS surface for meeting capture. Events (DeviceEventEmitter):
 *  MeetingRecorder:segment  {index, path, startMs, durationMs, wallStartMs, speechRatio, meanDb}
 *  MeetingRecorder:level    {db, elapsedMs, isSpeech}
 *  MeetingRecorder:state    {state, elapsedMs}   state = recording|paused|stopped
 *  MeetingRecorder:error    {message}
 *  MeetingRecorder:silenced {silenced}
 *  MeetingRecorder:stopRequested {}             user tapped Stop in the notification
 *  MeetingRecorder:importProgress {decodedMs, totalMs}
 *  MeetingRecorder:shared {}                    audio was shared in; call consumeSharedAudio()
 */
class MeetingRecorderModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), MeetingRecorderEngine.Listener, ActivityEventListener {

    override fun getName() = "MeetingRecorder"

    private var pickPromise: Promise? = null
    @Volatile private var importer: AudioFileImporter? = null

    // On a JS reload the new module is created before the old one is invalidated; only
    // the owner may clear the hook, or warm shares would stop reaching JS.
    private val onShared: () -> Unit = { emit("MeetingRecorder:shared", Arguments.createMap()) }

    init {
        ctx.addActivityEventListener(this)
        MeetingRecorderEngine.addListener(this)
        MeetingRecorderService.onStopFromNotification = {
            emit("MeetingRecorder:stopRequested", Arguments.createMap())
        }
        SharedAudio.onCaptured = onShared
    }

    override fun invalidate() {
        ctx.removeActivityEventListener(this)
        importer?.cancelled = true
        MeetingRecorderEngine.removeListener(this)
        MeetingRecorderService.onStopFromNotification = null
        if (SharedAudio.onCaptured === onShared) SharedAudio.onCaptured = null
        super.invalidate()
    }

    private fun emit(event: String, payload: WritableMap) {
        if (!ctx.hasActiveReactInstance()) return
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, payload)
    }

    // --- Engine listener -------------------------------------------------

    override fun onSegment(segment: MeetingRecorderEngine.Segment) {
        emit("MeetingRecorder:segment", Arguments.createMap().apply {
            putInt("index", segment.index)
            putString("path", segment.path)
            putDouble("startMs", segment.startMs.toDouble())
            putDouble("durationMs", segment.durationMs.toDouble())
            putDouble("wallStartMs", segment.wallStartMs.toDouble())
            putDouble("speechRatio", segment.speechRatio)
            putDouble("meanDb", segment.meanDb)
        })
    }

    override fun onLevel(db: Double, elapsedMs: Long, isSpeech: Boolean) {
        emit("MeetingRecorder:level", Arguments.createMap().apply {
            putDouble("db", db)
            putDouble("elapsedMs", elapsedMs.toDouble())
            putBoolean("isSpeech", isSpeech)
        })
    }

    override fun onState(state: String, elapsedMs: Long) {
        emit("MeetingRecorder:state", Arguments.createMap().apply {
            putString("state", state)
            putDouble("elapsedMs", elapsedMs.toDouble())
        })
    }

    override fun onError(message: String) {
        emit("MeetingRecorder:error", Arguments.createMap().apply { putString("message", message) })
    }

    override fun onSilenced(silenced: Boolean) {
        emit("MeetingRecorder:silenced", Arguments.createMap().apply { putBoolean("silenced", silenced) })
    }

    // --- Methods ---------------------------------------------------------

    @ReactMethod
    fun start(opts: ReadableMap, promise: Promise) {
        try {
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED
            ) {
                promise.reject("NO_PERMISSION", "RECORD_AUDIO not granted"); return
            }
            val dir = opts.getString("dir") ?: run {
                promise.reject("BAD_ARGS", "dir is required"); return
            }
            val cfg = MeetingRecorderEngine.Config(
                dir = dir.removePrefix("file://"),
                minSegmentSec = if (opts.hasKey("minSegmentSec")) opts.getDouble("minSegmentSec") else 18.0,
                maxSegmentSec = if (opts.hasKey("maxSegmentSec")) opts.getDouble("maxSegmentSec") else 29.0,
                startIndex = if (opts.hasKey("startIndex")) opts.getInt("startIndex") else 0,
                startOffsetMs = if (opts.hasKey("startOffsetMs")) opts.getDouble("startOffsetMs").toLong() else 0L,
                source = if (opts.hasKey("source")) opts.getString("source") ?: "voice_recognition" else "voice_recognition",
            )
            val foreground = !opts.hasKey("foreground") || opts.getBoolean("foreground")
            val title = if (opts.hasKey("title")) opts.getString("title") ?: "Meeting" else "Meeting"

            // Foreground service must be up before capture starts (Android 14 while-in-use rule).
            if (foreground) {
                ContextCompat.startForegroundService(
                    ctx,
                    MeetingRecorderService.intent(ctx, MeetingRecorderService.ACTION_RECORD)
                        .putExtra(MeetingRecorderService.EXTRA_TITLE, title)
                )
            }
            MeetingRecorderEngine.start(ctx, cfg)
            promise.resolve(null)
        } catch (e: Throwable) {
            promise.reject("START_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun pause(promise: Promise) { MeetingRecorderEngine.pause(); promise.resolve(null) }

    @ReactMethod
    fun resume(promise: Promise) { MeetingRecorderEngine.resume(); promise.resolve(null) }

    /** Stops capture; resolves after the final segment event has been queued. */
    @ReactMethod
    fun stop(promise: Promise) {
        Thread {
            try {
                MeetingRecorderEngine.stop()
                promise.resolve(MeetingRecorderEngine.elapsedMs.toDouble())
            } catch (e: Throwable) {
                promise.reject("STOP_FAILED", e.message, e)
            }
        }.start()
    }

    /** Switches the service to processing mode (keeps CPU alive for STT + LLM). */
    @ReactMethod
    fun setProcessing(text: String, promise: Promise) {
        try {
            ContextCompat.startForegroundService(
                ctx,
                MeetingRecorderService.intent(ctx, MeetingRecorderService.ACTION_PROCESS)
                    .putExtra(MeetingRecorderService.EXTRA_TEXT, text)
            )
            promise.resolve(null)
        } catch (e: Throwable) {
            // Background FGS start can be refused on Android 12+; processing still runs in-process.
            promise.resolve(null)
        }
    }

    /** Removes the notification and stops the service. */
    @ReactMethod
    fun release(promise: Promise) {
        try {
            ctx.startService(MeetingRecorderService.intent(ctx, MeetingRecorderService.ACTION_DISMISS))
        } catch (_: Throwable) {
            ctx.stopService(MeetingRecorderService.intent(ctx, MeetingRecorderService.ACTION_DISMISS))
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        promise.resolve(Arguments.createMap().apply {
            putString("state", MeetingRecorderEngine.state)
            putDouble("elapsedMs", MeetingRecorderEngine.elapsedMs.toDouble())
            putInt("segmentsWritten", MeetingRecorderEngine.segmentsWritten)
            putString("dir", MeetingRecorderEngine.currentConfig?.dir)
        })
    }

    /** Fixes WAV headers left inconsistent by a crash; returns data bytes. */
    @ReactMethod
    fun repairWav(path: String, promise: Promise) {
        try {
            promise.resolve(WavSegmentWriter.repair(path.removePrefix("file://")).toDouble())
        } catch (e: Throwable) {
            promise.reject("REPAIR_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun needsNotificationPermission(promise: Promise) {
        promise.resolve(
            Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
        )
    }

    // --- Upload a recording ------------------------------------------------

    /** Storage Access Framework picker: audio or video (meeting apps often save .mp4). */
    @ReactMethod
    fun pickAudio(promise: Promise) {
        val activity = ctx.currentActivity ?: run {
            promise.reject("NO_ACTIVITY", "App is not in the foreground"); return
        }
        pickPromise?.reject("SUPERSEDED", "Another picker was opened")
        pickPromise = promise
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            // Some providers label raw ADTS .aac as x-aac or octet-stream rather than audio/aac.
            putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf(
                    "audio/*", "video/*", "audio/aac", "audio/x-aac", "audio/aacp",
                    "audio/amr", "audio/3gpp", "application/ogg", "application/octet-stream",
                ),
            )
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        try {
            activity.startActivityForResult(intent, PICK_AUDIO_REQUEST)
        } catch (e: Throwable) {
            pickPromise = null
            promise.reject("PICKER_FAILED", e.message, e)
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK_AUDIO_REQUEST) return
        val promise = pickPromise ?: return
        pickPromise = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) { promise.resolve(null); return }
        Thread {
            try {
                runCatching {
                    ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                var name = uri.lastPathSegment ?: "Recording"
                var size = -1.0
                ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val sz = c.getColumnIndex(OpenableColumns.SIZE)
                        if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                        if (sz >= 0 && !c.isNull(sz)) size = c.getLong(sz).toDouble()
                    }
                }
                var durationMs = 0.0
                runCatching {
                    val r = MediaMetadataRetriever()
                    try {
                        r.setDataSource(ctx, uri)
                        durationMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                            ?.toDoubleOrNull() ?: 0.0
                    } finally {
                        r.release()
                    }
                }
                promise.resolve(Arguments.createMap().apply {
                    putString("uri", uri.toString())
                    putString("name", name)
                    putDouble("size", size)
                    putDouble("durationMs", durationMs)
                    putString("mime", ctx.contentResolver.getType(uri))
                })
            } catch (e: Throwable) {
                promise.reject("PICK_FAILED", e.message, e)
            }
        }.start()
    }

    override fun onNewIntent(intent: Intent) {}

    /** Files shared into the app since the last call (copied to the cache; file:// URIs). */
    @ReactMethod
    fun consumeSharedAudio(promise: Promise) {
        promise.resolve(Arguments.createArray().apply {
            SharedAudio.consume().forEach { item ->
                pushMap(Arguments.createMap().apply {
                    putString("uri", item.uri)
                    putString("name", item.name)
                    putDouble("size", item.size)
                    putDouble("durationMs", item.durationMs)
                    putString("mime", item.mime)
                })
            }
        })
    }

    /** Decodes [uri] into 16 kHz mono WAV segments in [dir]; resolves {segments, durationMs}. */
    @ReactMethod
    fun importAudio(uri: String, dir: String, opts: ReadableMap?, promise: Promise) {
        if (importer != null) { promise.reject("BUSY", "An import is already running"); return }
        val job = AudioFileImporter(
            ctx,
            Uri.parse(uri),
            dir.removePrefix("file://"),
            segmentSec = if (opts?.hasKey("segmentSec") == true) opts.getInt("segmentSec") else 30,
            startIndex = if (opts?.hasKey("startIndex") == true) opts.getInt("startIndex") else 0,
        )
        importer = job
        Thread({
            try {
                val (segments, durationMs) = job.run { decoded, total ->
                    emit("MeetingRecorder:importProgress", Arguments.createMap().apply {
                        putDouble("decodedMs", decoded.toDouble())
                        putDouble("totalMs", total.toDouble())
                    })
                }
                promise.resolve(Arguments.createMap().apply {
                    putDouble("durationMs", durationMs.toDouble())
                    putArray("segments", Arguments.createArray().apply {
                        for (seg in segments) pushMap(Arguments.createMap().apply {
                            putInt("index", seg.index)
                            putString("path", seg.path)
                            putDouble("startMs", seg.startMs.toDouble())
                            putDouble("durationMs", seg.durationMs.toDouble())
                            putDouble("speechRatio", seg.speechRatio)
                            putDouble("meanDb", seg.meanDb)
                        })
                    })
                })
            } catch (e: InterruptedException) {
                promise.reject("CANCELLED", "Import cancelled")
            } catch (e: Throwable) {
                promise.reject("IMPORT_FAILED", e.message ?: e.toString(), e)
            } finally {
                importer = null
            }
        }, "MeetingAudioImport").start()
    }

    @ReactMethod
    fun cancelImport(promise: Promise) {
        importer?.cancelled = true
        promise.resolve(null)
    }

    // Required by NativeEventEmitter on the JS side; events go via DeviceEventEmitter.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Double) {}

    companion object {
        private const val PICK_AUDIO_REQUEST = 47_211
    }
}
