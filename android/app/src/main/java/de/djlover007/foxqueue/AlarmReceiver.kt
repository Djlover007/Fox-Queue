package de.djlover007.foxqueue

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** „Alarm aus“ in der Benachrichtigung oder Wegwischen stoppt den Ton. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            ACTION_STOP_ALARM -> { Store.load(ctx); Store.stopAlarm() }
            // Startzeit eines Ziels erreicht
            ACTION_START_AT -> { Store.load(ctx); Store.fireDueStarts(ctx) }
            // Nach einem Neustart des Handys die Startzeiten wieder einplanen (macht load)
            Intent.ACTION_BOOT_COMPLETED -> { Store.load(ctx); Store.scheduleStarts(ctx) }
        }
    }

    companion object {
        const val ACTION_STOP_ALARM = "de.djlover007.foxqueue.STOP_ALARM"
        const val ACTION_START_AT = "de.djlover007.foxqueue.START_AT"
    }
}
