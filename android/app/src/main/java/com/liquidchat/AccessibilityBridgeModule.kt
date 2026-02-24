package com.liquidchat

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.facebook.react.bridge.*
import org.json.JSONObject

class AccessibilityBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AccessibilityBridge"

    @ReactMethod
    fun isServiceEnabled(promise: Promise) {
        try {
            val context = reactApplicationContext
            val expectedComponent = ComponentName(context, LiquidChatAccessibilityService::class.java)
            val enabledServices = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""

            val enabled = TextUtils.SimpleStringSplitter(':').run {
                setString(enabledServices)
                var found = false
                while (hasNext()) {
                    val component = ComponentName.unflattenFromString(next())
                    if (component != null && component == expectedComponent) {
                        found = true
                        break
                    }
                }
                found
            }

            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.reject("CHECK_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun performAction(actionJson: String, promise: Promise) {
        val lbm = LocalBroadcastManager.getInstance(reactApplicationContext)
        val handler = Handler(Looper.getMainLooper())
        var resolved = false

        // Register result receiver
        val resultReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (resolved) return
                resolved = true
                handler.removeCallbacksAndMessages(null)
                lbm.unregisterReceiver(this)

                val resultJson = intent.getStringExtra("result_json") ?: "{}"
                promise.resolve(resultJson)
            }
        }

        lbm.registerReceiver(resultReceiver, IntentFilter(LiquidChatAccessibilityService.ACTION_RESULT))

        // Timeout after 5 seconds
        handler.postDelayed({
            if (!resolved) {
                resolved = true
                lbm.unregisterReceiver(resultReceiver)
                promise.reject("TIMEOUT", "Accessibility service did not respond within 5 seconds. Is the service enabled?")
            }
        }, 5000)

        // Send action to service
        val intent = Intent(LiquidChatAccessibilityService.ACTION_PERFORM).apply {
            putExtra("action_json", actionJson)
        }
        lbm.sendBroadcast(intent)
    }

    @ReactMethod
    fun openAccessibilitySettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactApplicationContext.startActivity(intent)
            promise.resolve("Opened accessibility settings")
        } catch (e: Exception) {
            promise.reject("SETTINGS_ERROR", e.message, e)
        }
    }
}
