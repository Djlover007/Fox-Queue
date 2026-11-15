package de.djlover007.foxqueue

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** „Alarm aus“ in der Benachrichtigung oder Wegwischen stoppt den Ton. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == ACTION_STOP_ALARM) {
            Store.load(ctx)
            Store.stopAlarm()
        }
    }

    companion object { const val ACTION_STOP_ALARM = "de.djlover007.foxqueue.STOP_ALARM" }
}
