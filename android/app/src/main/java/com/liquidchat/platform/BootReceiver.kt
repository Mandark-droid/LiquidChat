package com.liquidchat.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Re-registers persisted alarms after events that wipe or invalidate AlarmManager state:
 * reboot, app update, wall-clock change and time-zone change.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED -> {
                try {
                    val n = AlarmStore.rescheduleAll(context)
                    Log.i("LiquidChatAlarms", "Re-registered $n alarm(s) after ${intent.action}")
                } catch (e: Exception) {
                    Log.w("LiquidChatAlarms", "Re-register after ${intent.action} failed", e)
                }
            }
        }
    }
}
