package com.dtinth.vxbeamer.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Runs one recording for the picture-in-picture screen
 * ([PipTranscribeActivity]), as a foreground service so capture survives the
 * user switching away to another app (dtinth/vxbeamer#86).
 *
 * The recording itself is [TranscriptionSession]'s — shared with
 * [FloatingWindowService]. All this adds is the foreground-service and
 * notification wrapper, and stopping itself once the recording is done.
 */
class PipRecordingService : Service() {
    private val scope = CoroutineScope(Dispatchers.IO)
    private var job: Job? = null
    private var session: TranscriptionSession? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> session?.requestStop()
            else -> startRecording()
        }
        return START_NOT_STICKY
    }

    private fun startRecording() {
        // Idle, a finished copy, or a previous session's error are all fine to
        // start from — only an already-running session blocks a new one.
        if (Transcription.state.value.isActive) return

        val hasMic =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (!hasMic) {
            stopSelf()
            return
        }

        try {
            startForegroundCompat()
        } catch (t: Throwable) {
            Log.e(TAG, "Could not start the foreground recording notification", t)
            Transcription.publishStandalone(Transcription.State.Error(t.message ?: t.javaClass.simpleName))
            stopSelf()
            return
        }

        val next = TranscriptionSession(this)
        session = next
        job =
            scope.launch {
                next.run()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
    }

    private fun startForegroundCompat() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(NOTIFICATION_CHANNEL_ID, "vxbeamer transcribing", NotificationManager.IMPORTANCE_LOW),
        )
        val notification =
            NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
                .setContentTitle("vxbeamer")
                .setContentText("Listening…")
                .setSmallIcon(R.drawable.ic_tile_mic)
                .setOngoing(true)
                .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onDestroy() {
        session?.requestStop()
        job?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.dtinth.vxbeamer.mobile.action.START_PIP_RECORDING"
        const val ACTION_STOP = "com.dtinth.vxbeamer.mobile.action.STOP_PIP_RECORDING"

        private const val TAG = "PipRecordingService"
        private const val NOTIFICATION_ID = 2
        private const val NOTIFICATION_CHANNEL_ID = "pip_transcribe"
    }
}
