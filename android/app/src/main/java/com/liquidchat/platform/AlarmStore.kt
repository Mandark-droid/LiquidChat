package com.liquidchat.platform

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONException
import org.json.JSONObject

/**
 * Persistent registry of scheduled agent alarms. AlarmManager forgets everything on
 * reboot, app update and clock changes, so every alarm lives here as JSON until it fires
 * or is cancelled, and [rescheduleAll] re-registers the lot.
 */
object AlarmStore {

    data class Spec(
        val id: String,
        val triggerAtMs: Long,
        val title: String,
        val body: String,
        val payload: String,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("id", id)
            .put("triggerAtMs", triggerAtMs)
            .put("title", title)
            .put("body", body)
            .put("payload", payload)

        companion object {
            fun fromJson(o: JSONObject): Spec = Spec(
                id = o.getString("id"),
                triggerAtMs = o.getLong("triggerAtMs"),
                title = o.optString("title", ""),
                body = o.optString("body", ""),
                payload = o.optString("payload", ""),
            )
        }
    }

    const val ACTION_FIRE = "com.liquidchat.platform.ALARM_FIRE"
    const val EXTRA_ID = "alarm_id"

    private const val PREFS = "liquidchat_alarms"
    private const val KEY_ALARMS = "alarms"
    private val lock = Any()

    private fun load(context: Context): JSONObject {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ALARMS, null) ?: return JSONObject()
        return try {
            JSONObject(raw)
        } catch (e: JSONException) {
            JSONObject()
        }
    }

    private fun save(context: Context, all: JSONObject) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ALARMS, all.toString())
            .commit()
    }

    fun put(context: Context, spec: Spec) {
        synchronized(lock) {
            val all = load(context)
            all.put(spec.id, spec.toJson())
            save(context, all)
        }
    }

    fun get(context: Context, id: String): Spec? {
        synchronized(lock) {
            val o = load(context).optJSONObject(id) ?: return null
            return try {
                Spec.fromJson(o)
            } catch (e: JSONException) {
                null
            }
        }
    }

    fun remove(context: Context, id: String) {
        synchronized(lock) {
            val all = load(context)
            if (all.has(id)) {
                all.remove(id)
                save(context, all)
            }
        }
    }

    fun all(context: Context): List<Spec> {
        synchronized(lock) {
            val all = load(context)
            val out = ArrayList<Spec>()
            val keys = all.keys()
            while (keys.hasNext()) {
                val o = all.optJSONObject(keys.next()) ?: continue
                try {
                    out.add(Spec.fromJson(o))
                } catch (e: JSONException) {
                    // skip corrupt entry
                }
            }
            return out
        }
    }

    // --- AlarmManager wiring ---------------------------------------------------

    private fun firePendingIntent(context: Context, id: String, flags: Int): PendingIntent? {
        val intent = Intent(context, AlarmReceiver::class.java)
            .setAction(ACTION_FIRE)
            // Data makes each alarm's PendingIntent distinct even if request codes collide.
            .setData(Uri.parse("liquidchat-alarm://fire/" + Uri.encode(id)))
            .putExtra(EXTRA_ID, id)
        return PendingIntent.getBroadcast(
            context,
            id.hashCode(),
            intent,
            flags or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /** Registers with AlarmManager. A trigger time in the past fires as soon as possible. */
    fun register(context: Context, spec: Spec) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = firePendingIntent(context, spec.id, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
        // Inexact but Doze-safe; needs neither SCHEDULE_EXACT_ALARM nor USE_EXACT_ALARM.
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, spec.triggerAtMs, pi)
    }

    fun unregister(context: Context, id: String) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = firePendingIntent(context, id, PendingIntent.FLAG_NO_CREATE) ?: return
        am.cancel(pi)
        pi.cancel()
    }

    fun rescheduleAll(context: Context): Int {
        var n = 0
        for (spec in all(context)) {
            try {
                register(context, spec)
                n++
            } catch (e: Exception) {
                android.util.Log.w("LiquidChatAlarms", "Failed to re-register ${spec.id}", e)
            }
        }
        return n
    }
}
