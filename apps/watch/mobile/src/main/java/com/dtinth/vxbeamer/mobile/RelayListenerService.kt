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
 * Declared in the manifest against `CHANNEL_EVENT`, so Android starts this
 * service on its own the moment the watch app opens a channel — this app
 * does not need to be running, and does not need a notification, until that
 * actually happens (dtinth/vxbeamer#86). Once a channel opens, it becomes a
 * foreground service for the length of that one relay, then goes back to
 * being nothing until the next recording.
 */
class RelayListenerService : WearableListenerService() {
    private val scope = CoroutineScope(Dispatchers.IO)
    private var relayJob: Job? = null

    override fun onChannelOpened(channel: ChannelClient.Channel) {
        if (channel.path != CHANNEL_PATH) return
        relayJob = scope.launch { relay(channel) }
    }

    override fun onChannelClosed(channel: ChannelClient.Channel, closeReason: Int, appSpecificErrorCode: Int) {
        // The relay loop's own `read()` already returns -1 on a normal
        // close, so this mostly matters for an abnormal one arriving before
        // the loop even starts reading.
        if (channel.path != CHANNEL_PATH) return
        relayJob?.cancel()
    }

    private suspend fun relay(channel: ChannelClient.Channel) {
        val authStore = AuthStore(this)
        if (!authStore.isSignedIn) return

        startForeground(NOTIFICATION_ID, buildNotification())
        var webSocket: BackendWebSocket? = null
        try {
            val accessToken = authStore.currentAccessToken()
            val referenceId = UUID.randomUUID().toString()
            webSocket = BackendWebSocket.connect(authStore.backendUrl, accessToken, referenceId)

            val channelClient = Wearable.getChannelClient(this)
            val input = channelClient.getInputStream(channel).await()
            input.use {
                val buffer = ByteArray(READ_BUFFER_BYTES)
                while (true) {
                    val read = it.read(buffer)
                    if (read <= 0) break
                    webSocket.send(buffer.copyOf(read))
                }
            }
            webSocket.stop()
        } catch (t: Throwable) {
            webSocket?.abort()
        } finally {
            stopForeground(STOP_FOREGROUND_REMOVE)
        }
    }

    private fun buildNotification(): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(NOTIFICATION_CHANNEL_ID, "Relaying to vxbeamer", NotificationManager.IMPORTANCE_LOW),
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Relaying watch audio to vxbeamer")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        relayJob?.cancel()
        super.onDestroy()
    }

    companion object {
        // Must match RecordingService.CHANNEL_PATH in the wear module —
        // the two modules are separate APKs with no shared code module, so
        // this is duplicated rather than shared. Keep both in sync by hand.
        private const val CHANNEL_PATH = "/vxbeamer/audio"
        private const val READ_BUFFER_BYTES = 3200
        private const val NOTIFICATION_ID = 1
        private const val NOTIFICATION_CHANNEL_ID = "relay"
    }
}
