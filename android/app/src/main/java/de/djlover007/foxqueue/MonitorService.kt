package de.djlover007.foxqueue

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** Vordergrund-Dienst: prüft die Ziele auch bei ausgeschaltetem Bildschirm. */
class MonitorService : Service() {
    private var worker: Thread? = null
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Store.load(this)
        if (intent?.action == ACTION_STOP) {
            stopMonitor()
            return START_NOT_STICKY
        }

        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, MonitorService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val active = Store.targets.count { it.enabled }
        val n = Notification.Builder(this, Store.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_fox)
            .setContentTitle("Fox Queue überwacht")
            .setContentText("$active Ziel(e) · alle ${Store.intervalSec} s")
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat_fox), "Stop", stop).build())
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(1, n)

        if (worker?.isAlive != true) {
            Store.running = true
            Store.resetRun()
            Store.log("info", "Monitor gestartet – $active Ziel(e), alle ${Store.intervalSec} s.")
            wake = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FoxQueue::monitor").apply { acquire() }
            worker = Thread {
                try {
                    while (Store.running) {
                        Store.runRound(this)
                        val jitter = (Math.random() * minOf(10.0, Store.intervalSec * 0.15) * 1000).toLong()
                        var waited = 0L
                        val total = Store.intervalSec * 1000L + jitter
                        while (Store.running && waited < total) { Thread.sleep(500); waited += 500 }
                    }
                } catch (_: InterruptedException) { }
            }.apply { name = "fox-monitor"; start() }
        }
        return START_STICKY
    }

    private fun stopMonitor() {
        if (Store.running) Store.log("info", "Monitor gestoppt.")
        Store.running = false
        Store.targets.forEach { it.live = false }
        worker?.interrupt()
        worker = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        Store.running = false
        worker?.interrupt()
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    companion object { const val ACTION_STOP = "de.djlover007.foxqueue.STOP" }
}
