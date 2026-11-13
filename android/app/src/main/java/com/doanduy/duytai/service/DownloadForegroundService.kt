package com.doanduy.duytai.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.doanduy.duytai.core.DuytaiEngine
import com.doanduy.duytai.core.FormatCatalog
import com.doanduy.duytai.ui.MainActivity
import kotlinx.coroutines.*
import java.io.File

class DownloadForegroundService : Service() {

    inner class LocalBinder : Binder() {
        val engine: DuytaiEngine get() = this@DownloadForegroundService.engine
    }

    private val binder = LocalBinder()
    lateinit var engine: DuytaiEngine
        private set

    private var wakeLock: PowerManager.WakeLock? = null
    private var idleStopJob: Job? = null
    private var isInForeground = false
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        val stagingRoot = File(
            getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir,
            "Duytai"
        )
        engine = DuytaiEngine(stagingRoot, applicationContext)
        ensureChannel()
        startMonitoringNotifications()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        promoteToForeground("Duytai Engine v7.5 sẵn sàng (64/128 luồng)")

        val url = intent?.getStringExtra(EXTRA_URL)
        val threads = intent?.getIntExtra(EXTRA_THREADS, 64) ?: 64
        if (!url.isNullOrBlank()) {
            engine.enqueue(url, maxConnections = threads, startImmediately = true)
        }
        return START_STICKY
    }

    private fun promoteToForeground(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
        isInForeground = true
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15 (API 35) dataSync 6h foreground quota guard
        engine.pauseAll()
        stopForeground(STOP_FOREGROUND_DETACH)
        isInForeground = false
        stopSelf(startId)
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        serviceScope.cancel()
        releaseWakeLock()
        engine.shutdown()
        super.onDestroy()
    }

    private fun startMonitoringNotifications() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        serviceScope.launch {
            engine.jobList.collect { list ->
                val active = list.filter { it.status.name == "DOWNLOADING" || it.status.name == "PROBING" }
                if (active.isNotEmpty()) {
                    idleStopJob?.cancel()
                    idleStopJob = null
                    acquireWakeLock()
                    val first = active.first()
                    val spd = FormatCatalog.formatBytes(engine.aggregateSpeedBps) + "/s"
                    val summary = "${active.size} file • ${first.progressPercent}% • $spd"
                    if (!isInForeground) {
                        promoteToForeground(summary)
                    } else {
                        nm.notify(NOTIF_ID, buildNotification(summary))
                    }
                } else {
                    releaseWakeLock()
                    if (isInForeground && idleStopJob == null) {
                        idleStopJob = serviceScope.launch {
                            delay(12_000L)
                            if (engine.activeDownloadCount == 0) {
                                runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
                                isInForeground = false
                            }
                            idleStopJob = null
                        }
                    }
                }
            }
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Duytai::DownloadLock").apply {
            acquire(10 * 60 * 1000L)
        }
    }

    private fun releaseWakeLock() {
        runCatching {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Duytai Multi-Thread Downloads",
                NotificationManager.IMPORTANCE_LOW
            )
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("⚡ Duytai Downloader")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "duytai_downloads"
        const val NOTIF_ID = 17890
        const val EXTRA_URL = "extra_url"
        const val EXTRA_THREADS = "extra_threads"
    }
}
