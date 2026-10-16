package com.liquidchat.platform

import android.app.Notification
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject

/**
 * Captures notifications the user has allowed the assistant to read. Runs in the app
 * process whenever notification access is granted (even with the UI closed), so it must
 * not touch React: it appends redacted entries to [NotificationInbox] and, if a React
 * instance is alive, pings it through [NotificationInbox.onPosted].
 */
class LiquidChatNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        try {
            handle(sbn)
        } catch (e: Exception) {
            Log.w(TAG, "onNotificationPosted failed", e)
        }
    }

    private fun handle(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        if (pkg == packageName) return

        val n: Notification = sbn.notification ?: return
        if (sbn.isOngoing) return
        if ((n.flags and Notification.FLAG_FOREGROUND_SERVICE) != 0) return
        if ((n.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return

        val filters = NotificationInbox.readFilters(this)
        if (!NotificationInbox.isPackageAllowed(filters, pkg)) return

        val extras = n.extras
        val title = extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            ?: extras?.getCharSequence(Notification.EXTRA_TITLE_BIG)?.toString()
            ?: ""
        val big = extras?.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        val plain = extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        val rawText = if (!big.isNullOrEmpty()) big else (plain ?: "")
        if (title.isEmpty() && rawText.isEmpty()) return

        val entry = JSONObject()
            .put("key", sbn.key)
            .put("packageName", pkg)
            .put("appLabel", appLabel(pkg, extras))
            .put("title", NotificationInbox.redact(title))
            .put("text", NotificationInbox.redact(rawText))
            .put("postedAt", sbn.postTime)
            .put("isOngoing", false)
        val category = n.category
        if (category != null) entry.put("category", category)

        NotificationInbox.append(this, entry)
        NotificationInbox.onPosted?.invoke(entry)
    }

    /**
     * The system embeds the poster's ApplicationInfo in the extras ("android.appInfo"),
     * which avoids needing package visibility (<queries>/QUERY_ALL_PACKAGES) on API 30+.
     */
    private fun appLabel(pkg: String, extras: Bundle?): String {
        val pm = packageManager
        try {
            val embedded = embeddedAppInfo(extras)
            if (embedded != null) {
                val label = pm.getApplicationLabel(embedded).toString()
                if (label.isNotEmpty()) return label
            }
        } catch (e: Exception) {
            // fall through to a package lookup
        }
        return lookupLabel(pkg)
    }

    @Suppress("DEPRECATION")
    private fun embeddedAppInfo(extras: Bundle?): ApplicationInfo? {
        if (extras == null) return null
        // Typed getter only from API 34: the API 33 implementation has known bugs.
        if (Build.VERSION.SDK_INT >= 34) {
            return extras.getParcelable(EXTRA_APP_INFO, ApplicationInfo::class.java)
        }
        return extras.getParcelable<ApplicationInfo>(EXTRA_APP_INFO)
    }

    @Suppress("DEPRECATION")
    private fun lookupLabel(pkg: String): String {
        return try {
            val pm = packageManager
            val info: ApplicationInfo = if (Build.VERSION.SDK_INT >= 33) {
                pm.getApplicationInfo(pkg, PackageManager.ApplicationInfoFlags.of(0L))
            } else {
                pm.getApplicationInfo(pkg, 0)
            }
            pm.getApplicationLabel(info).toString()
        } catch (e: Exception) {
            pkg
        }
    }

    companion object {
        private const val TAG = "LiquidChatNotif"
        private const val EXTRA_APP_INFO = "android.appInfo"
    }
}
