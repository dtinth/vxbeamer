package com.dtinth.vxbeamer.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Receives audio from the watch and files it as a recording.
 *
 * Declared in the manifest against `CHANNEL_EVENT`, so Android starts this
 * on its own the moment the watch opens a channel — this app does not need
 * to be running, and costs nothing, until that happens
 * (dtinth/vxbeamer#86).
 *
 * The bytes go into [RecordingStore] exactly as the phone's own microphone's
 * would, and [Recorder]'s queue uploads them from there. That is what gives
 * watch recordings the same history and the same retry as local ones,
 * instead of a second, separate upload path that could fail differently.
 */
class RelayListenerService : WearableListenerService() {
    private val scope = CoroutineScope(Dispatchers.IO)
    private var relayJob: Job? = null

    override fun onChannelOpened(channel: ChannelClient.Channel) {
        if (channel.path != CHANNEL_PATH) return
        relayJob = scope.launch { relay(channel) }
    }

    override fun onChannelClosed(channel: ChannelClient.Channel, closeReason: Int, appSpecificErrorCode: Int) {
        // The relay loop's own `read()` returns -1 on a normal close, so this
        // mostly matters for an abnormal one arriving before it starts reading.
        if (channel.path != CHANNEL_PATH) return
        relayJob?.cancel()
    }

    private suspend fun relay(channel: ChannelClient.Channel) {
        Recorder.initialize(this)
        val store = Recorder.store
        val recording = store.beginRecording(UUID.randomUUID().toString(), System.currentTimeMillis())

        startForeground(NOTIFICATION_ID, buildNotification())
        try {
            val channelClient = Wearable.getChannelClient(this)
            val input = channelClient.getInputStream(channel).await()
            // Written the same way the microphone writes, so an upload can
            // tail this file while the watch is still speaking into it.
            store.audioFile(recording).outputStream().use { output ->
                input.use {
                    val buffer = ByteArray(READ_BUFFER_BYTES)
                    while (true) {
                        val read = it.read(buffer)
                        if (read <= 0) break
                        output.write(buffer, 0, read)
                        output.flush()
                    }
                }
            }
        } catch (t: Throwable) {
            store.update(recording.id) {
                it.copy(status = RecordingStatus.FAILED, error = t.message ?: t.javaClass.simpleName)
            }
        } finally {
            // Queues it for upload, or drops it if no audio ever arrived.
            store.finishCapture(recording.id)
            // Bring the transmitter service up so the queue actually drains —
            // this listener is torn down as soon as the channel closes.
            RecorderService.send(this, RecorderService.ACTION_DRAIN)
            stopForeground(STOP_FOREGROUND_REMOVE)
        }
    }

    private fun buildNotification(): android.app.Notification {
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(
                NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    "Receiving from watch",
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Receiving audio from the watch")
            .setSmallIcon(R.drawable.ic_tile_mic)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        relayJob?.cancel()
        super.onDestroy()
    }

    companion object {
        // Must match RecordingService.CHANNEL_PATH in the wear module — the
        // two are separate APKs with no shared code module, so this is
        // duplicated rather than shared. Keep both in sync by hand.
        private const val CHANNEL_PATH = "/vxbeamer/audio"
        private const val READ_BUFFER_BYTES = 3200
        private const val NOTIFICATION_ID = 1
        private const val NOTIFICATION_CHANNEL_ID = "relay"
    }
}
