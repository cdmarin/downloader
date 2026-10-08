package com.cdmarin.clipsaver

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the app alive while downloads run in the background and shows their progress
 * in a notification. The downloads themselves run in [DownloadEngine].
 */
class DownloadService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var lastStartId = 0

    private val tick = object : Runnable {
        override fun run() {
            val state = DownloadEngine.notificationState()
            if (state == null) {
                ServiceCompat.stopForeground(this@DownloadService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelfResult(lastStartId)
                return
            }
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(state))
            handler.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(DownloadEngine.notificationState()),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
        handler.removeCallbacks(tick)
        handler.post(tick)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        super.onDestroy()
    }

    private fun buildNotification(state: DownloadEngine.NotificationState?): android.app.Notification {
        val title = when {
            state?.isSpeed == true -> getString(R.string.notification_speed)
            state?.isTrim == true -> getString(R.string.notification_trimming)
            state?.status == "downloading" -> getString(R.string.notification_downloading)
            state?.status == "processing" -> getString(R.string.notification_processing)
            else -> getString(R.string.notification_preparing)
        }
        val percent = state?.percent
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(percent?.let { "$it%" })
            .setProgress(100, percent ?: 0, percent == null)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "downloads"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, DownloadService::class.java))
        }
    }
}
