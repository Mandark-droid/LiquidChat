package com.liquidchat.platform

import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject

/**
 * JS surface for captured notifications (src/platform/types.ts: NotificationSource).
 *
 * Event (DeviceEventEmitter): "Notifications:posted" with a CapturedNotification payload,
 * emitted only while a React instance is active. Entries are also queued on disk, so
 * drain() returns them regardless of whether the event was delivered.
 */
class NotificationsModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "Notifications"

    private val postedListener: (JSONObject) -> Unit = { entry -> emitPosted(entry) }

    init {
        NotificationInbox.onPosted = postedListener
    }

    override fun invalidate() {
        // On reload the new instance may already have registered itself; only clear our own.
        if (NotificationInbox.onPosted === postedListener) NotificationInbox.onPosted = null
        super.invalidate()
    }

    private fun emitPosted(entry: JSONObject) {
        if (!ctx.hasActiveReactInstance()) return
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("Notifications:posted", toMap(entry))
        } catch (e: Exception) {
            // The entry stays queued on disk for drain().
        }
    }

    private fun toMap(o: JSONObject): WritableMap = Arguments.createMap().apply {
        putString("key", o.optString("key", ""))
        putString("packageName", o.optString("packageName", ""))
        putString("appLabel", o.optString("appLabel", ""))
        putString("title", o.optString("title", ""))
        putString("text", o.optString("text", ""))
        if (o.has("category") && !o.isNull("category")) putString("category", o.optString("category"))
        putDouble("postedAt", o.optLong("postedAt", 0L).toDouble())
        putBoolean("isOngoing", o.optBoolean("isOngoing", false))
    }

    @ReactMethod
    fun isAccessGranted(promise: Promise) {
        try {
            promise.resolve(
                NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
            )
        } catch (e: Exception) {
            promise.reject("CHECK_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun openAccessSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SETTINGS_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun drain(promise: Promise) {
        try {
            val out = Arguments.createArray()
            for (entry in NotificationInbox.drain(ctx)) out.pushMap(toMap(entry))
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("DRAIN_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun setFilters(filters: ReadableMap, promise: Promise) {
        try {
            val allow = stringList(if (filters.hasKey("allow")) filters.getArray("allow") else null)
            val block = stringList(if (filters.hasKey("block")) filters.getArray("block") else null)
            val retention = if (filters.hasKey("retentionDays") && !filters.isNull("retentionDays")) {
                filters.getDouble("retentionDays").toInt()
            } else {
                7
            }
            NotificationInbox.writeFilters(ctx, allow, block, retention)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("FILTERS_FAILED", e.message, e)
        }
    }

    private fun stringList(arr: ReadableArray?): List<String> {
        if (arr == null) return emptyList()
        val out = ArrayList<String>(arr.size())
        for (i in 0 until arr.size()) {
            val s = arr.getString(i)
            if (!s.isNullOrEmpty()) out.add(s)
        }
        return out
    }

    // Required by NativeEventEmitter on the JS side; events go via DeviceEventEmitter.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Double) {}
}
