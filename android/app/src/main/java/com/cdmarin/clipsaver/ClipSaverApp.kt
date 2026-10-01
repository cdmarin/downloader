package com.cdmarin.clipsaver

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class ClipSaverApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(
            DownloadService.CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        DownloadEngine.initialize(this)
    }
}
