package com.liquidchat

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.CalendarContract
import android.provider.Settings
import android.app.NotificationManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import com.facebook.react.bridge.*

class SystemControlsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SystemControls"

    @ReactMethod
    fun setBrightness(level: Double, promise: Promise) {
        try {
            val context = reactApplicationContext
            if (!Settings.System.canWrite(context)) {
                val intent = Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                promise.reject("PERMISSION_REQUIRED", "WRITE_SETTINGS permission required. Opening settings...")
                return
            }

            // Normalize 0-100 to 0-255
            val brightness = ((level.coerceIn(0.0, 100.0) / 100.0) * 255).toInt()
            Settings.System.putInt(
                context.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            Settings.System.putInt(
                context.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS,
                brightness
            )
            promise.resolve("Brightness set to ${level.toInt()}%")
        } catch (e: Exception) {
            promise.reject("BRIGHTNESS_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setVolume(stream: String, level: Double, promise: Promise) {
        try {
            val audioManager = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

            val streamType = when (stream.lowercase()) {
                "media", "music" -> AudioManager.STREAM_MUSIC
                "ring", "ringtone" -> AudioManager.STREAM_RING
                "alarm" -> AudioManager.STREAM_ALARM
                "notification" -> AudioManager.STREAM_NOTIFICATION
                "system" -> AudioManager.STREAM_SYSTEM
                "voice", "call" -> AudioManager.STREAM_VOICE_CALL
                else -> AudioManager.STREAM_MUSIC
            }

            val maxVolume = audioManager.getStreamMaxVolume(streamType)
            val targetVolume = ((level.coerceIn(0.0, 100.0) / 100.0) * maxVolume).toInt()
            audioManager.setStreamVolume(streamType, targetVolume, 0)
            promise.resolve("Volume (${stream}) set to ${level.toInt()}%")
        } catch (e: Exception) {
            promise.reject("VOLUME_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun toggleBluetooth(enable: Boolean, promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // Android 13+: Can't toggle programmatically, open settings
                val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactApplicationContext.startActivity(intent)
                promise.resolve("Opened Bluetooth settings (Android 13+ requires manual toggle)")
                return
            }

            val bluetoothManager = reactApplicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val adapter = bluetoothManager?.adapter

            if (adapter == null) {
                promise.reject("BT_UNAVAILABLE", "Bluetooth is not available on this device")
                return
            }

            @Suppress("DEPRECATION")
            if (enable) {
                adapter.enable()
                promise.resolve("Bluetooth enabled")
            } else {
                adapter.disable()
                promise.resolve("Bluetooth disabled")
            }
        } catch (e: SecurityException) {
            // Missing permission - open settings as fallback
            val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve("Opened Bluetooth settings (permission required for direct toggle)")
        } catch (e: Exception) {
            promise.reject("BT_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun toggleDnd(enable: Boolean, promise: Promise) {
        try {
            val notificationManager = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            if (!notificationManager.isNotificationPolicyAccessGranted) {
                val intent = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactApplicationContext.startActivity(intent)
                promise.reject("PERMISSION_REQUIRED", "Notification policy access required. Opening settings...")
                return
            }

            notificationManager.setInterruptionFilter(
                if (enable) NotificationManager.INTERRUPTION_FILTER_NONE
                else NotificationManager.INTERRUPTION_FILTER_ALL
            )
            promise.resolve(if (enable) "Do Not Disturb enabled" else "Do Not Disturb disabled")
        } catch (e: Exception) {
            promise.reject("DND_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun toggleRotationLock(enable: Boolean, promise: Promise) {
        try {
            val context = reactApplicationContext
            if (!Settings.System.canWrite(context)) {
                val intent = Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                promise.reject("PERMISSION_REQUIRED", "WRITE_SETTINGS permission required. Opening settings...")
                return
            }

            // 0 = auto-rotate enabled, 1 = rotation locked
            Settings.System.putInt(
                context.contentResolver,
                Settings.System.ACCELEROMETER_ROTATION,
                if (enable) 0 else 1
            )
            promise.resolve(if (enable) "Rotation lock enabled" else "Rotation lock disabled")
        } catch (e: Exception) {
            promise.reject("ROTATION_ERROR", e.message, e)
        }
    }

    /**
     * Opens the calendar app's "new event" screen prefilled; the user saves it. Linking.sendIntent
     * cannot do this: it sets no data URI (so no calendar app matches ACTION_INSERT) and sends
     * times as doubles, which calendar apps read as 0.
     */
    @ReactMethod
    fun insertCalendarEvent(
        title: String,
        beginMs: Double,
        endMs: Double,
        allDay: Boolean,
        description: String?,
        promise: Promise,
    ) {
        try {
            val intent = Intent(Intent.ACTION_INSERT).apply {
                data = CalendarContract.Events.CONTENT_URI
                putExtra(CalendarContract.Events.TITLE, title)
                putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, beginMs.toLong())
                putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endMs.toLong())
                putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, allDay)
                if (!description.isNullOrBlank()) putExtra(CalendarContract.Events.DESCRIPTION, description)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            // No resolveActivity() pre-check: without a <queries> entry, Android 11+ package
            // visibility hides the calendar app from it even though startActivity works.
            val activity = reactApplicationContext.currentActivity
            if (activity != null) {
                intent.removeFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(intent)
            } else {
                reactApplicationContext.startActivity(intent)
            }
            promise.resolve(true)
        } catch (e: android.content.ActivityNotFoundException) {
            promise.reject("NO_CALENDAR", "No calendar app is installed.")
        } catch (e: Exception) {
            promise.reject("CALENDAR_ERROR", e.message, e)
        }
    }

    /**
     * Starts an activity for [action]. Unlike Linking.sendIntent there is no resolveActivity()
     * pre-check (Android 11+ package visibility makes it fail for apps that do exist), and extras
     * keep their JS types: AlarmClock ignores HOUR/MINUTES sent as strings.
     */
    @ReactMethod
    fun launchIntent(
        action: String,
        data: String?,
        type: String?,
        extras: ReadableMap?,
        promise: Promise,
    ) {
        try {
            val intent = Intent(action)
            when {
                data != null && type != null -> intent.setDataAndType(Uri.parse(data), type)
                data != null -> intent.data = Uri.parse(data)
                type != null -> intent.type = type
            }
            extras?.let { map ->
                val it = map.keySetIterator()
                while (it.hasNextKey()) {
                    val key = it.nextKey()
                    when (map.getType(key)) {
                        ReadableType.Boolean -> intent.putExtra(key, map.getBoolean(key))
                        ReadableType.Number -> {
                            val n = map.getDouble(key)
                            if (n == Math.floor(n) && n <= Int.MAX_VALUE && n >= Int.MIN_VALUE)
                                intent.putExtra(key, n.toInt())
                            else intent.putExtra(key, n)
                        }
                        ReadableType.String -> intent.putExtra(key, map.getString(key))
                        else -> {}
                    }
                }
            }
            val activity = reactApplicationContext.currentActivity
            if (activity != null) activity.startActivity(intent)
            else reactApplicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            promise.resolve(true)
        } catch (e: android.content.ActivityNotFoundException) {
            promise.reject("NO_APP", "No app on this phone can handle $action.")
        } catch (e: Exception) {
            promise.reject("INTENT_ERROR", e.message, e)
        }
    }
}
