package com.dtinth.vxbeamer.wear

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.io.OutputStream

/**
 * Captures the mic and streams it to the phone over a [ChannelClient]
 * channel, raw — 16 kHz / 16-bit / mono / little-endian, the exact format
 * vxbeamer's own `/ws` already expects (dtinth/vxbeamer#86), so the phone
 * app only has to relay bytes, never transcode them.
 *
 * The phone side is the one that actually reaches vxbeamer; this service
 * knows nothing about the backend, a session, or auth — it only knows how
 * to open a channel at [CHANNEL_PATH] and keep pushing bytes into it until
 * told to stop.
 */
class RecordingService : Service() {
    private var job: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopRecording()
            return START_NOT_STICKY
        }

        if (isRunning) return START_NOT_STICKY

        val hasMic =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (!hasMic) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification())
        isRunning = true
        job = scope.launch { runRecording() }
        return START_NOT_STICKY
    }

    private fun stopRecording() {
        job?.cancel()
        job = null
        isRunning = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private suspend fun runRecording() {
        val channelClient = Wearable.getChannelClient(this)
        val nodeId = findPhoneNodeId(this) ?: return

        val channel = channelClient.openChannel(nodeId, CHANNEL_PATH).await()
        try {
            val output = channelClient.getOutputStream(channel).await()
            captureInto(output)
        } finally {
            channelClient.close(channel).await()
        }
    }

    /** [MIN_BUFFER_MULTIPLIER]x the platform minimum, so a slow phone-side
     *  read never has to fight [AudioRecord] for buffer space mid-stream. */
    private fun captureInto(output: OutputStream) {
        // onStartCommand already checked this before launching the coroutine
        // that leads here — lint can't see across that boundary, and it is
        // real defense in depth against permission being revoked mid-session.
        val hasMic =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (!hasMic) return

        val minBuffer =
            AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val bufferSize = minBuffer * MIN_BUFFER_MULTIPLIER

        val audioRecord =
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize,
            )
        val readBuffer = ByteArray(CHUNK_BYTES)
        try {
            audioRecord.startRecording()
            output.use {
                while (true) {
                    val read = audioRecord.read(readBuffer, 0, readBuffer.size)
                    if (read <= 0) break
                    output.write(readBuffer, 0, read)
                }
            }
        } finally {
            audioRecord.stop()
            audioRecord.release()
        }
    }

    private fun buildNotification(): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(NOTIFICATION_CHANNEL_ID, "Recording", NotificationManager.IMPORTANCE_LOW),
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Recording")
            .setSmallIcon(android.R.drawable.presence_audio_online)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        job?.cancel()
        isRunning = false
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_STOP = "com.dtinth.vxbeamer.wear.action.STOP"
        // Must match RelayListenerService.CHANNEL_PATH in the mobile module —
        // the two are separate APKs with no shared code module, so this is
        // duplicated rather than shared. Keep both in sync by hand.
        const val CHANNEL_PATH = "/vxbeamer/audio"
        private const val SAMPLE_RATE_HZ = 16000
        private const val CHUNK_BYTES = 3200 // 100 ms at 16 kHz / 16-bit / mono
        private const val MIN_BUFFER_MULTIPLIER = 4
        private const val NOTIFICATION_ID = 1
        private const val NOTIFICATION_CHANNEL_ID = "recording"

        /** Read by the UI to reflect whether a recording is in progress —
         *  see [MainActivity]'s own note on why a plain var is enough here. */
        @Volatile
        var isRunning: Boolean = false
            private set
    }
}

private suspend fun findPhoneNodeId(context: android.content.Context): String? =
    Wearable.getNodeClient(context).connectedNodes.await().firstOrNull()?.id
