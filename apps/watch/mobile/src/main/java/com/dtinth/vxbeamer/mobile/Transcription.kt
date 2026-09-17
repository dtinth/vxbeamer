package com.dtinth.vxbeamer.mobile

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.UUID
import kotlin.math.min
import kotlin.math.sqrt
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONObject

/**
 * One recording, captured from the phone's mic and streamed to vxbeamer's
 * `/ws` — the same wire format [RelayListenerService] forwards from the
 * watch, just captured locally (dtinth/vxbeamer#86).
 *
 * This is deliberately *not* a Service: two different surfaces run
 * recordings ([PipRecordingService] for the picture-in-picture screen,
 * [FloatingWindowService] for the draggable overlay), and only the
 * foreground-service and notification concerns differ between them. The
 * capture, the socket, the transcript watching and the clipboard copy are
 * identical, so they live here once.
 *
 * Progress is published on [Transcription], not returned — both callers are
 * UIs that need to follow a recording they did not necessarily start.
 */
class TranscriptionSession(private val context: Context) {
    @Volatile private var stopRequested = false
    private var finalReceived: CompletableDeferred<Unit>? = null

    /** Identifies this session to [Transcription], and is also the
     *  `reference_id` the backend echoes back on this recording's message. */
    private val sessionId = UUID.randomUUID().toString()

    fun requestStop() {
        stopRequested = true
        val current = Transcription.state.value
        if (current is Transcription.State.Recording) {
            Transcription.publish(sessionId, Transcription.State.Finishing(current.text))
        }
    }

    /** Runs one whole recording, returning only once it has finished. */
    suspend fun run() {
        var webSocket: BackendWebSocket? = null
        var eventSource: EventSource? = null
        var error: String? = null
        finalReceived = CompletableDeferred()
        Transcription.beginSession(sessionId)
        try {
            // AuthStore's construction touches the Android Keystore
            // (EncryptedSharedPreferences) — deliberately inside this try so a
            // Keystore failure surfaces like any other instead of crashing the
            // caller's service uncaught.
            val authStore = AuthStore(context)
            if (!authStore.isSignedIn) error("Not signed in")
            val accessToken = authStore.currentAccessToken()
            webSocket = BackendWebSocket.connect(authStore.backendUrl, accessToken, sessionId)
            eventSource = watchTranscript(authStore.backendUrl, accessToken, sessionId)
            captureAndStream(webSocket)
            webSocket.stop()
            // The final transcript can arrive slightly after the socket closes
            // — grace window rather than tearing down the moment the mic stops.
            withTimeoutOrNull(FINAL_GRACE_PERIOD_MS) { finalReceived?.await() }
        } catch (t: Throwable) {
            Log.e(TAG, "Transcription session failed", t)
            error = t.message ?: t.javaClass.simpleName
            webSocket?.abort()
        } finally {
            eventSource?.cancel()
            // Keeps a copied transcript on screen rather than blanking it the
            // instant the recording ends — but only this session's own.
            val ending =
                when {
                    error != null -> Transcription.State.Error(error)
                    else -> Transcription.state.value as? Transcription.State.Copied ?: Transcription.State.Idle
                }
            Transcription.endSession(sessionId, ending)
        }
    }

    /** [MIN_BUFFER_MULTIPLIER]x the platform minimum, matching the wear
     *  module's own capture buffer sizing (see `RecordingService.kt` there). */
    private fun captureAndStream(webSocket: BackendWebSocket) {
        // The caller checked this before starting, but lint cannot see across
        // that boundary and permission really can be revoked mid-session.
        val hasMic =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (!hasMic) error("Microphone permission was revoked")

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
            while (!stopRequested) {
                val read = audioRecord.read(readBuffer, 0, readBuffer.size)
                if (read <= 0) break
                Transcription.publishLevel(sessionId, levelOf(readBuffer, read))
                webSocket.send(readBuffer.copyOf(read))
            }
        } finally {
            audioRecord.stop()
            audioRecord.release()
        }
    }

    /**
     * Rough loudness of one chunk, 0..1, for the overlay's level meter. RMS
     * over the 16-bit samples rather than a peak, so a single click does not
     * pin the meter; scaled by [LEVEL_FULL_SCALE] because ordinary speech
     * sits far below a full-scale sine and a true 0..32767 mapping would
     * barely move.
     */
    private fun levelOf(buffer: ByteArray, length: Int): Float {
        var sumOfSquares = 0.0
        var count = 0
        var i = 0
        while (i + 1 < length) {
            val sample = ((buffer[i + 1].toInt() shl 8) or (buffer[i].toInt() and 0xFF)).toShort().toInt()
            sumOfSquares += (sample.toDouble() * sample.toDouble())
            count++
            i += 2
        }
        if (count == 0) return 0f
        val rms = sqrt(sumOfSquares / count)
        return min(1.0, rms / LEVEL_FULL_SCALE).toFloat()
    }

    private fun watchTranscript(backendUrl: String, accessToken: String, referenceId: String): EventSource {
        val url =
            backendUrl.toHttpUrl().newBuilder()
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
     * `updated` carry one `message`, `snapshot` carries the whole list. Only
     * this session's own `referenceId` matters.
     *
     * Copies on the *first* non-empty `final`, regardless of `status` — the
     * backend can deliver `final` slightly ahead of the follow-up event that
     * flips `status` to `"done"`, the same race
     * `apps/website/src/components/messageFeedScroll.ts`'s `isMessageCopyable`
     * had to account for (dtinth/vxbeamer#86).
     */
    private fun handleSseEvent(event: JSONObject, referenceId: String) {
        if (Transcription.currentSession != sessionId) return
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
            Transcription.publish(sessionId, Transcription.State.Copied(final))
            if (finalReceived?.isCompleted == false) finalReceived?.complete(Unit)
            return
        }

        val partial = message.optString("partial", "")
        when (val current = Transcription.state.value) {
            is Transcription.State.Recording ->
                Transcription.publish(sessionId, Transcription.State.Recording(partial.ifEmpty { current.text }))
            is Transcription.State.Finishing ->
                Transcription.publish(sessionId, Transcription.State.Finishing(partial.ifEmpty { current.text }))
            else -> Unit
        }
    }

    private fun copyToClipboard(text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Transcript", text))
    }

    companion object {
        private const val TAG = "TranscriptionSession"
        private const val SAMPLE_RATE_HZ = 16000
        private const val CHUNK_BYTES = 3200 // 100 ms at 16 kHz / 16-bit / mono
        private const val MIN_BUFFER_MULTIPLIER = 4
        private const val FINAL_GRACE_PERIOD_MS = 20_000L
        private const val LEVEL_FULL_SCALE = 6000.0

        private val sseClient = OkHttpClient()
    }
}

/** Whatever recording is currently running, for any UI that wants to follow it. */
object Transcription {
    sealed interface State {
        data object Idle : State

        data class Recording(val text: String?) : State

        data class Finishing(val text: String?) : State

        /** A transcript arrived and is now on the clipboard. */
        data class Copied(val text: String) : State

        data class Error(val message: String) : State

        /** True only while a recording is actually running — the states a new
         *  recording must not start on top of. */
        val isActive: Boolean
            get() = this is Recording || this is Finishing
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    /** Rough mic loudness, 0..1, while recording; 0 otherwise. */
    private val _audioLevel = MutableStateFlow(0f)
    val audioLevel: StateFlow<Float> = _audioLevel.asStateFlow()

    /**
     * The only session allowed to publish right now.
     *
     * `/sse` carries every message on the account, not just this device's, and
     * a session's stream stays open through a grace period after its own
     * recording ends. Without this, a late event — a stale listener, or
     * another device's recording arriving mid-session — could publish a
     * transcript that has nothing to do with the recording being shown
     * (dtinth/vxbeamer#86). Per-event `referenceId` filtering already scopes
     * *which* message a session reads; this scopes *which session* may speak.
     */
    @Volatile private var currentSessionId: String? = null

    internal val currentSession: String?
        get() = currentSessionId

    internal fun beginSession(sessionId: String) {
        currentSessionId = sessionId
        _state.value = State.Recording(text = null)
    }

    internal fun endSession(sessionId: String, state: State) {
        if (currentSessionId != sessionId) return
        currentSessionId = null
        _audioLevel.value = 0f
        _state.value = state
    }

    internal fun publish(sessionId: String, state: State) {
        if (currentSessionId != sessionId) return
        _state.value = state
    }

    internal fun publishLevel(sessionId: String, level: Float) {
        if (currentSessionId != sessionId) return
        _audioLevel.value = level
    }

    /** Used by a service that failed before a session ever began. */
    internal fun publishStandalone(state: State) {
        if (currentSessionId != null) return
        _state.value = state
    }
}
