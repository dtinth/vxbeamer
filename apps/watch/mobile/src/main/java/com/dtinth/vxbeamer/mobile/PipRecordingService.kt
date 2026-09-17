package com.dtinth.vxbeamer.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONObject

/**
 * Captures the phone's own mic and streams it straight to vxbeamer's `/ws`
 * — the same wire format [RelayListenerService] forwards from the watch,
 * just captured locally instead of relayed (dtinth/vxbeamer#86). Runs as a
 * foreground service for the whole recording, since the point of the PiP
 * screen is to keep listening while the user has switched to another app.
 *
 * Also opens `/sse` for the duration, the same way the web app does, to
 * learn when *this* recording's transcript finalizes — the `/ws` connection
 * itself is send-only, so there is no other way to know. Once a `final`
 * transcript for this session's `referenceId` arrives, it is copied to the
 * clipboard automatically, mirroring the web app's own click-to-copy.
 */
class PipRecordingService : Service() {
    private val scope = CoroutineScope(Dispatchers.IO)
    private var job: Job? = null

    @Volatile private var stopSignal = false
    private var finalReceived: CompletableDeferred<Unit>? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopRecording()
            else -> startRecording()
        }
        return START_NOT_STICKY
    }

    private fun startRecording() {
        if (_state.value !is State.Idle) return

        val hasMic =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (!hasMic) {
            stopSelf()
            return
        }

        startForegroundCompat(buildNotification("Listening…"))
        stopSignal = false
        _state.value = State.Recording(text = null)
        job = scope.launch { runSession() }
    }

    private fun stopRecording() {
        val current = _state.value
        if (current is State.Recording) _state.value = State.Finishing(current.text)
        stopSignal = true
    }

    private suspend fun runSession() {
        val authStore = AuthStore(this)
        if (!authStore.isSignedIn) {
            finish()
            return
        }

        var webSocket: BackendWebSocket? = null
        var eventSource: EventSource? = null
        finalReceived = CompletableDeferred()
        try {
            val accessToken = authStore.currentAccessToken()
            val referenceId = UUID.randomUUID().toString()
            webSocket = BackendWebSocket.connect(authStore.backendUrl, accessToken, referenceId)
            eventSource = watchTranscript(authStore.backendUrl, accessToken, referenceId)
            captureAndStream(webSocket)
            webSocket.stop()
            // The final transcript can arrive slightly after the socket
            // closes — give it a grace window rather than tearing down the
            // moment the mic stops.
            withTimeoutOrNull(FINAL_GRACE_PERIOD_MS) { finalReceived?.await() }
        } catch (t: Throwable) {
            webSocket?.abort()
        } finally {
            eventSource?.cancel()
            finish()
        }
    }

    private fun finish() {
        _state.value = State.Idle
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** [MIN_BUFFER_MULTIPLIER]x the platform minimum, matching the wear
     *  module's own capture buffer sizing (see `RecordingService.kt` there). */
    private fun captureAndStream(webSocket: BackendWebSocket) {
        // startRecording already checked this before launching the coroutine
        // that leads here — lint can't see across that boundary, and it is
        // real defense in depth against permission being revoked mid-session
        // (same guard the wear module's RecordingService.kt has).
        val hasMic =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (!hasMic) return

        val minBuffer =
            AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val audioRecord =
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuffer * MIN_BUFFER_MULTIPLIER,
            )
        val readBuffer = ByteArray(CHUNK_BYTES)
        try {
            audioRecord.startRecording()
            while (!stopSignal) {
                val read = audioRecord.read(readBuffer, 0, readBuffer.size)
                if (read <= 0) break
                webSocket.send(readBuffer.copyOf(read))
            }
        } finally {
            audioRecord.stop()
            audioRecord.release()
        }
    }

    private fun watchTranscript(backendUrl: String, accessToken: String, referenceId: String): EventSource {
        val httpUrl = backendUrl.toHttpUrl()
        val url =
            httpUrl.newBuilder()
                .encodedPath("/sse")
                .query(null)
                .addQueryParameter("access_token", accessToken)
                .build()
        val request = Request.Builder().url(url).build()
        return EventSources.createFactory(sseClient).newEventSource(
            request,
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    runCatching { JSONObject(data) }.getOrNull()?.let { handleSseEvent(it, referenceId) }
                }
            },
        )
    }

    /**
     * Mirrors `applySSEEvent` in `apps/website/src/store.ts`: `created` and
     * `updated` events carry one `message`, `snapshot` carries the whole
     * list. Only this session's own `referenceId` matters here.
     *
     * Copies on the *first* non-empty `final`, regardless of `status` —
     * the backend can deliver `final` slightly ahead of the follow-up event
     * that flips `status` to `"done"`, the same race
     * `apps/website/src/components/messageFeedScroll.ts`'s
     * `isMessageCopyable` had to account for (dtinth/vxbeamer#86).
     */
    private fun handleSseEvent(event: JSONObject, referenceId: String) {
        val messages =
            when (event.optString("type")) {
                "created", "updated" -> listOfNotNull(event.optJSONObject("message"))
                "snapshot" ->
                    event.optJSONArray("messages")?.let { arr -> (0 until arr.length()).map { arr.getJSONObject(it) } }
                        ?: emptyList()
                else -> emptyList()
            }
        val message = messages.find { it.optString("referenceId") == referenceId } ?: return

        val final = message.optString("final", "")
        if (final.isNotEmpty()) {
            copyToClipboard(final)
            if (finalReceived?.isCompleted == false) finalReceived?.complete(Unit)
            return
        }

        val partial = message.optString("partial", "")
        val current = _state.value
        if (current is State.Recording) _state.value = State.Recording(partial.ifEmpty { current.text })
        else if (current is State.Finishing) _state.value = State.Finishing(partial.ifEmpty { current.text })
    }

    private fun copyToClipboard(text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Transcript", text))
        updateNotification(buildNotification("Copied: $text"))
    }

    private fun updateNotification(notification: android.app.Notification) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun startForegroundCompat(notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(text: String): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(NOTIFICATION_CHANNEL_ID, "vxbeamer transcribing", NotificationManager.IMPORTANCE_LOW),
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("vxbeamer")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.presence_audio_online)
            .setOngoing(_state.value !is State.Idle)
            .build()
    }

    override fun onDestroy() {
        job?.cancel()
        _state.value = State.Idle
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    sealed interface State {
        data object Idle : State

        data class Recording(val text: String?) : State

        data class Finishing(val text: String?) : State
    }

    companion object {
        const val ACTION_START = "com.dtinth.vxbeamer.mobile.action.START_PIP_RECORDING"
        const val ACTION_STOP = "com.dtinth.vxbeamer.mobile.action.STOP_PIP_RECORDING"

        private const val SAMPLE_RATE_HZ = 16000
        private const val CHUNK_BYTES = 3200 // 100 ms at 16 kHz / 16-bit / mono
        private const val MIN_BUFFER_MULTIPLIER = 4
        private const val FINAL_GRACE_PERIOD_MS = 20_000L
        private const val NOTIFICATION_ID = 2
        private const val NOTIFICATION_CHANNEL_ID = "pip_transcribe"

        private val sseClient = OkHttpClient()

        private val _state = MutableStateFlow<State>(State.Idle)
        val state: StateFlow<State> = _state.asStateFlow()
    }
}
