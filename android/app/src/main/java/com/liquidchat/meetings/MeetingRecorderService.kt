package com.liquidchat.meetings

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import com.liquidchat.MainActivity

/**
 * Foreground service that keeps the process (and CPU) alive while a meeting is
 * being recorded, and afterwards while it is transcribed/summarised.
 *
 *  - mode "record":  type=microphone (required for background capture, Android 14+)
 *  - mode "process": type=mediaProcessing on Android 15+, dataSync before that
 *
 * The capture itself lives in [MeetingRecorderEngine]; this service only holds
 * foreground status, a partial wake lock and the notification controls.
 */
class MeetingRecorderService : Service(), MeetingRecorderEngine.Listener {

    companion object {
        const val ACTION_RECORD = "com.liquidchat.meetings.RECORD"
        const val ACTION_PROCESS = "com.liquidchat.meetings.PROCESS"
        const val ACTION_PAUSE = "com.liquidchat.meetings.PAUSE"
        const val ACTION_RESUME = "com.liquidchat.meetings.RESUME"
        const val ACTION_STOP = "com.liquidchat.meetings.STOP"
        const val ACTION_DISMISS = "com.liquidchat.meetings.DISMISS"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"

        private const val CHANNEL_ID = "meeting_recording"
        private const val NOTIFICATION_ID = 0x4D45 // "ME"

        /** Fired when the user taps Stop in the notification. */
        @Volatile var onStopFromNotification: (() -> Unit)? = null

        fun intent(ctx: Context, action: String) =
            Intent(ctx, MeetingRecorderService::class.java).setAction(action)
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var title = "Meeting"
    private var processingText = ""
    private var mode = "record"
    private var lastNotifyAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        MeetingRecorderEngine.addListener(this)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LiquidChat:Meeting").apply {
            setReferenceCounted(false)
            acquire(6 * 60 * 60 * 1000L) // hard cap: 6 h
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getStringExtra(EXTRA_TITLE)?.let { title = it }
        when (intent?.action) {
            ACTION_RECORD -> { mode = "record"; goForeground() }
            ACTION_PROCESS -> {
                mode = "process"
                processingText = intent.getStringExtra(EXTRA_TEXT) ?: "Processing meeting…"
                goForeground()
            }
            ACTION_PAUSE -> { MeetingRecorderEngine.pause(); notifyNow() }
            ACTION_RESUME -> { MeetingRecorderEngine.resume(); notifyNow() }
            ACTION_STOP -> {
                // Let JS own the stop sequence (it must persist state); fall back to a direct stop.
                val cb = onStopFromNotification
                if (cb != null) cb() else Thread { MeetingRecorderEngine.stop() }.start()
            }
            ACTION_DISMISS -> { stopForegroundCompat(); stopSelf() }
            else -> if (intent == null) {
                // Restarted by the system after process death: nothing to resume safely.
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun goForeground() {
        val n = build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val type = if (mode == "record") {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else if (Build.VERSION.SDK_INT >= 35) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING
            } else {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            }
            startForeground(NOTIFICATION_ID, n, type)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun build(): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        fun action(a: String, req: Int) = PendingIntent.getService(
            this, req, intent(this, a),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(title)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

        if (mode == "record") {
            val st = MeetingRecorderEngine.state
            val elapsed = MeetingRecorderEngine.elapsedMs
            val label = if (st == "paused") "Paused" else "Recording"
            b.setContentText("$label · ${MeetingRecorderEngine.segmentsWritten} segments")
            if (st == "recording") {
                b.setUsesChronometer(true).setWhen(System.currentTimeMillis() - elapsed)
                b.addAction(0, "Pause", action(ACTION_PAUSE, 1))
            } else {
                b.addAction(0, "Resume", action(ACTION_RESUME, 2))
            }
            b.addAction(0, "Stop", action(ACTION_STOP, 3))
        } else {
            b.setContentText(processingText).setProgress(0, 0, true)
        }
        return b.build()
    }

    private fun notifyNow() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, build())
        lastNotifyAt = SystemClock.elapsedRealtime()
    }

    fun updateProcessingText(text: String) {
        processingText = text
        notifyNow()
    }

    override fun onState(state: String, elapsedMs: Long) {
        if (mode == "record" && state != "stopped") notifyNow()
    }

    override fun onSegment(segment: MeetingRecorderEngine.Segment) {
        if (mode == "record" && SystemClock.elapsedRealtime() - lastNotifyAt > 4000) notifyNow()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Meeting recording", NotificationManager.IMPORTANCE_LOW)
                    .apply { description = "Shown while LiquidChat records or processes a meeting" }
            )
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION") stopForeground(true)
        }
    }

    override fun onDestroy() {
        MeetingRecorderEngine.removeListener(this)
        runCatching { wakeLock?.release() }
        wakeLock = null
        super.onDestroy()
    }
}
