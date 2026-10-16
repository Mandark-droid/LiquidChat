package com.liquidchat.platform

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Wake-up alarms for agent routines (src/platform/types.ts: AlarmScheduler).
 *
 * Event (DeviceEventEmitter): "AlarmScheduler:launchPayload" {} when a routine notification
 * is tapped while the JS runtime is alive; call consumeLaunchPayload() to read it.
 */
class AlarmSchedulerModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "AlarmScheduler"

    private val launchListener: () -> Unit = {
        if (ctx.hasActiveReactInstance()) {
            try {
                ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("AlarmScheduler:launchPayload", Arguments.createMap())
            } catch (e: Exception) {
                // JS will still read the payload via consumeLaunchPayload() on startup.
            }
        }
    }

    init {
        LaunchPayload.onCaptured = launchListener
    }

    override fun invalidate() {
        // On reload the new instance may already have registered itself; only clear our own.
        if (LaunchPayload.onCaptured === launchListener) LaunchPayload.onCaptured = null
        super.invalidate()
    }

    @ReactMethod
    fun schedule(alarm: ReadableMap, promise: Promise) {
        try {
            val id = if (alarm.hasKey("id")) alarm.getString("id") else null
            if (id.isNullOrEmpty()) {
                promise.reject("BAD_ARGS", "alarm.id is required")
                return
            }
            if (!alarm.hasKey("triggerAtMs") || alarm.isNull("triggerAtMs")) {
                promise.reject("BAD_ARGS", "alarm.triggerAtMs is required")
                return
            }
            val spec = AlarmStore.Spec(
                id = id,
                triggerAtMs = alarm.getDouble("triggerAtMs").toLong(),
                title = optString(alarm, "title"),
                body = optString(alarm, "body"),
                payload = optString(alarm, "payload"),
            )
            AlarmStore.put(ctx, spec)
            try {
                AlarmStore.register(ctx, spec)
            } catch (e: Exception) {
                AlarmStore.remove(ctx, id)
                throw e
            }
            AlarmReceiver.ensureChannel(ctx)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SCHEDULE_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun cancel(id: String, promise: Promise) {
        try {
            AlarmStore.remove(ctx, id)
            AlarmStore.unregister(ctx, id)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("CANCEL_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun consumeLaunchPayload(promise: Promise) {
        promise.resolve(LaunchPayload.consume())
    }

    /** Debug/inspection: ids of alarms still pending in the persistent store. */
    @ReactMethod
    fun listScheduled(promise: Promise) {
        try {
            val out = Arguments.createArray()
            for (spec in AlarmStore.all(ctx)) {
                out.pushMap(Arguments.createMap().apply {
                    putString("id", spec.id)
                    putDouble("triggerAtMs", spec.triggerAtMs.toDouble())
                    putString("title", spec.title)
                    putString("body", spec.body)
                    putString("payload", spec.payload)
                })
            }
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("LIST_FAILED", e.message, e)
        }
    }

    private fun optString(map: ReadableMap, key: String): String =
        if (map.hasKey(key) && !map.isNull(key)) map.getString(key) ?: "" else ""

    // Required by NativeEventEmitter on the JS side; events go via DeviceEventEmitter.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Double) {}
}
