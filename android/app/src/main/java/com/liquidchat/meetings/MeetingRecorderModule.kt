package com.liquidchat.meetings

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
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
 */
class MeetingRecorderModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx), MeetingRecorderEngine.Listener {

    override fun getName() = "MeetingRecorder"

    init {
        MeetingRecorderEngine.addListener(this)
        MeetingRecorderService.onStopFromNotification = {
            emit("MeetingRecorder:stopRequested", Arguments.createMap())
        }
    }

    override fun invalidate() {
        MeetingRecorderEngine.removeListener(this)
        MeetingRecorderService.onStopFromNotification = null
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

    // Required by NativeEventEmitter on the JS side; events go via DeviceEventEmitter.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Double) {}
}
