package com.liquidchat.platform

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.text.TextUtils
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.liquidchat.BuildConfig
import com.liquidchat.LiquidChatAccessibilityService
import kotlin.math.roundToInt

/**
 * Device context for the agent runtime (src/platform/types.ts: DeviceContextProvider,
 * DeviceStateReader and the special-permission half of PermissionChecker).
 *
 * Constants: { distribution: "play" | "full" } from the Gradle product flavor.
 */
class DeviceContextModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "DeviceContext"

    override fun getConstants(): Map<String, Any> =
        mapOf("distribution" to BuildConfig.DISTRIBUTION)

    // --- Snapshot ----------------------------------------------------------

    @ReactMethod
    fun snapshot(promise: Promise) {
        try {
            val out = Arguments.createMap()

            val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            val capacity = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            out.putInt("batteryPercent", if (capacity in 0..100) capacity else -1)
            out.putBoolean("charging", bm.isCharging)

            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            out.putBoolean("powerSaveMode", pm.isPowerSaveMode)
            out.putString("thermal", thermalStatus(pm))

            var online = false
            var unmetered = false
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val network = cm?.activeNetwork
            val caps: NetworkCapabilities? =
                if (cm != null && network != null) cm.getNetworkCapabilities(network) else null
            if (caps != null) {
                online = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                unmetered = online &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            }
            out.putBoolean("online", online)
            out.putBoolean("unmetered", unmetered)

            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mi = ActivityManager.MemoryInfo()
            am.getMemoryInfo(mi)
            out.putDouble("availableRamMb", (mi.availMem / (1024L * 1024L)).toDouble())
            out.putDouble("totalRamMb", (mi.totalMem / (1024L * 1024L)).toDouble())
            out.putBoolean("lowMemory", mi.lowMemory)

            out.putDouble("timestamp", System.currentTimeMillis().toDouble())
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("SNAPSHOT_FAILED", e.message, e)
        }
    }

    private fun thermalStatus(pm: PowerManager): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            when (pm.currentThermalStatus) {
                PowerManager.THERMAL_STATUS_NONE -> "none"
                PowerManager.THERMAL_STATUS_LIGHT -> "light"
                PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
                PowerManager.THERMAL_STATUS_SEVERE -> "severe"
                PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
                PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
                PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
                else -> "unknown"
            }
        } else {
            "unknown"
        }
    }

    // --- Device state read-back (verifiers) ----------------------------------

    @ReactMethod
    fun getInterruptionFilter(promise: Promise) {
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val value = when (nm.currentInterruptionFilter) {
                NotificationManager.INTERRUPTION_FILTER_ALL -> "all"
                NotificationManager.INTERRUPTION_FILTER_PRIORITY -> "priority"
                NotificationManager.INTERRUPTION_FILTER_ALARMS -> "alarms"
                NotificationManager.INTERRUPTION_FILTER_NONE -> "none"
                else -> "unknown"
            }
            promise.resolve(value)
        } catch (e: Exception) {
            promise.reject("STATE_ERROR", e.message, e)
        }
    }

    /** Same stream names as SystemControls.setVolume. Resolves 0-100. */
    @ReactMethod
    fun getStreamVolumePercent(stream: String, promise: Promise) {
        try {
            val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val type = when (stream.lowercase()) {
                "media", "music" -> AudioManager.STREAM_MUSIC
                "ring", "ringtone" -> AudioManager.STREAM_RING
                "alarm" -> AudioManager.STREAM_ALARM
                "notification" -> AudioManager.STREAM_NOTIFICATION
                "system" -> AudioManager.STREAM_SYSTEM
                "voice", "call" -> AudioManager.STREAM_VOICE_CALL
                else -> AudioManager.STREAM_MUSIC
            }
            val max = audio.getStreamMaxVolume(type)
            val cur = audio.getStreamVolume(type)
            val pct = if (max <= 0) 0 else ((cur.toDouble() / max.toDouble()) * 100.0).roundToInt()
            promise.resolve(pct)
        } catch (e: Exception) {
            promise.reject("STATE_ERROR", e.message, e)
        }
    }

    // --- Special permissions -------------------------------------------------

    @ReactMethod
    fun checkSpecial(id: String, promise: Promise) {
        try {
            val granted = when (id) {
                "special:notification_policy" -> {
                    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.isNotificationPolicyAccessGranted
                }
                "special:write_settings" -> Settings.System.canWrite(ctx)
                "special:accessibility" -> isAccessibilityServiceEnabled(ctx)
                "special:notification_listener" ->
                    NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
                "special:network" -> true
                else -> {
                    promise.reject("UNKNOWN_PERMISSION", "Unknown special permission: $id")
                    return
                }
            }
            promise.resolve(granted)
        } catch (e: Exception) {
            promise.reject("CHECK_ERROR", e.message, e)
        }
    }

    /** Opens the settings screen for a special permission. Resolves true if a screen was opened. */
    @ReactMethod
    fun openSpecialSettings(id: String, promise: Promise) {
        try {
            val intent = when (id) {
                "special:notification_policy" ->
                    Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
                "special:write_settings" ->
                    Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS)
                        .setData(Uri.parse("package:${ctx.packageName}"))
                "special:accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                "special:notification_listener" ->
                    Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                "special:network" -> {
                    promise.resolve(false)
                    return
                }
                else -> {
                    promise.reject("UNKNOWN_PERMISSION", "Unknown special permission: $id")
                    return
                }
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SETTINGS_ERROR", e.message, e)
        }
    }

    companion object {
        /** Same logic as AccessibilityBridgeModule.isServiceEnabled. */
        fun isAccessibilityServiceEnabled(context: Context): Boolean {
            val expected = ComponentName(context, LiquidChatAccessibilityService::class.java)
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: return false
            val splitter = TextUtils.SimpleStringSplitter(':')
            splitter.setString(enabled)
            while (splitter.hasNext()) {
                val component = ComponentName.unflattenFromString(splitter.next())
                if (component != null && component == expected) return true
            }
            return false
        }
    }
}
