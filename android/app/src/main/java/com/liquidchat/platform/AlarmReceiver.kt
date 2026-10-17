package com.liquidchat.platform

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.liquidchat.MainActivity

/**
 * Fired by AlarmManager for an agent routine. Posts a notification on channel
 * "agent_routines"; tapping it opens MainActivity with extra "liquidchat_payload",
 * which JS reads once via AlarmScheduler.consumeLaunchPayload(). One-shot alarms are
 * removed from [AlarmStore] once fired.
 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AlarmStore.ACTION_FIRE) return
        val id = intent.getStringExtra(AlarmStore.EXTRA_ID) ?: return
        val spec = AlarmStore.get(context, id)
        // Always drop it: alarms are one-shot; recurrence is decided by the JS scheduler.
        AlarmStore.remove(context, id)
        if (spec == null) {
            Log.w(TAG, "Alarm $id fired but is not in the store (cancelled?)")
            return
        }
        try {
            postNotification(context, spec)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to post notification for alarm $id", e)
        }
    }

    companion object {
        const val CHANNEL_ID = "agent_routines"
        const val EXTRA_PAYLOAD = "liquidchat_payload"
        private const val TAG = "LiquidChatAlarms"

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        "Agent routines",
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply { description = "Scheduled routines and reminders run by the assistant" }
                )
            }
        }

        fun canPostNotifications(context: Context): Boolean {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                return false
            }
            return NotificationManagerCompat.from(context).areNotificationsEnabled()
        }

        @SuppressLint("MissingPermission") // checked in canPostNotifications()
        fun postNotification(context: Context, spec: AlarmStore.Spec) {
            if (!canPostNotifications(context)) {
                Log.i(TAG, "Notifications not permitted; alarm ${spec.id} fired silently")
                return
            }
            ensureChannel(context)

            // No data URI on purpose: RN Linking would report it as the initial URL.
            // The per-alarm request code keeps PendingIntents for different alarms distinct.
            val open = Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_PAYLOAD, spec.payload)
            val contentIntent = PendingIntent.getActivity(
                context,
                spec.id.hashCode(),
                open,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )

            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(spec.title.ifEmpty { "LiquidChat" })
                .setContentText(spec.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(spec.body))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()

            NotificationManagerCompat.from(context).notify(spec.id.hashCode(), notification)
        }
    }
}
