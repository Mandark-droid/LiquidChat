package com.liquidchat.platform

import android.content.Intent

/**
 * Holds the payload of the routine notification that launched (or re-focused)
 * MainActivity until JS consumes it via AlarmScheduler.consumeLaunchPayload().
 */
object LaunchPayload {
    private var pending: String? = null

    /** Set by AlarmSchedulerModule so a running JS runtime hears about warm launches. */
    @Volatile var onCaptured: (() -> Unit)? = null

    /** Called from MainActivity.onCreate / onNewIntent. Strips the extra so it is read once. */
    fun capture(intent: Intent?) {
        if (intent == null) return
        val payload = intent.getStringExtra(AlarmReceiver.EXTRA_PAYLOAD) ?: return
        synchronized(this) { pending = payload }
        intent.removeExtra(AlarmReceiver.EXTRA_PAYLOAD)
        onCaptured?.invoke()
    }

    fun consume(): String? = synchronized(this) {
        val p = pending
        pending = null
        p
    }
}
