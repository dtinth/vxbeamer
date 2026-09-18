package com.dtinth.vxbeamer.mobile

import android.util.Log
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * Sends one recording's audio to the backend and waits for its transcript.
 *
 * **Reads from the file, never from the microphone.** Capture writes to disk
 * and this reads from disk, which is what makes a recording survive a failed
 * upload and stay retryable (dtinth/vxbeamer#86). The two run at the same
 * time in the normal case: this tails a file that capture is still writing,
 * so a transcript arrives as promptly as it did when the mic was wired
 * straight to the socket. The same code path, run later against a file that
 * is already complete, is a retry.
 */
class TranscriptionUploader(
    private val store: RecordingStore,
    private val authStore: AuthStore,
    private val clientId: String,
    private val onTranscript: (String) -> Unit,
) {
    /**
     * Streams [recording] and returns once it has a transcript or has
     * failed. Updates the store as it goes, so the UI follows along.
     *
     * [isCapturing] reports whether the mic is still filling this file;
     * while it is true, reaching the end of the file means "wait", not
     * "done".
     */
    suspend fun upload(recording: Recording, isCapturing: () -> Boolean) {
        store.update(recording.id) {
            it.copy(status = RecordingStatus.UPLOADING, attempts = it.attempts + 1, error = null)
        }

        var socket: BackendWebSocket? = null
        var events: EventSource? = null
        val transcript = CompletableDeferred<TranscriptUpdate>()

        try {
            val accessToken = authStore.currentAccessToken()
            val backendUrl = authStore.backendUrl
            socket = BackendWebSocket.connect(
                BackendUrls.webSocket(backendUrl, accessToken, recording.id, clientId),
            )
            events = watch(backendUrl, accessToken, recording.id, transcript)

            streamFile(store.audioFile(recording), socket, isCapturing)
            socket.stop()

            val result =
                withTimeoutOrNull(FINAL_TIMEOUT_MS) { transcript.await() }
                    ?: throw IllegalStateException("Timed out waiting for the transcript")

            when (result) {
                is TranscriptUpdate.Final -> {
                    store.update(recording.id) {
                        it.copy(status = RecordingStatus.DONE, transcript = result.text, error = null)
                    }
                    onTranscript(result.text)
                }
                is TranscriptUpdate.Failed -> fail(recording, result.message)
                is TranscriptUpdate.Partial -> fail(recording, "No final transcript arrived")
            }
        } catch (t: Throwable) {
            Log.e(TAG, "Upload failed for ${recording.id}", t)
            socket?.abort()
            fail(recording, t.message ?: t.javaClass.simpleName)
        } finally {
            events?.cancel()
        }
    }

    private fun fail(recording: Recording, message: String) {
        store.update(recording.id) { it.copy(status = RecordingStatus.FAILED, error = message) }
    }

    /**
     * Sends the file's bytes, waiting for more while capture is still
     * running. Chunks are capped at [MAX_SPEED_MULTIPLIER] times real time:
     * a live recording paces itself because the bytes are not there yet, but
     * a backlog item would otherwise dump minutes of audio at once, which
     * not every ASR provider behind the backend tolerates.
     */
    private suspend fun streamFile(
        file: File,
        socket: BackendWebSocket,
        isCapturing: () -> Boolean,
    ) {
        val buffer = ByteArray(CHUNK_BYTES)
        var offset = 0L
        val minimumChunkIntervalMs = (CHUNK_BYTES / PCM_BYTES_PER_MS) / MAX_SPEED_MULTIPLIER

        file.inputStream().use { stream ->
            while (true) {
                val available = file.length() - offset
                if (available <= 0) {
                    if (!isCapturing()) break
                    delay(WAIT_FOR_AUDIO_MS)
                    continue
                }
                val read = stream.read(buffer)
                if (read <= 0) {
                    if (!isCapturing()) break
                    delay(WAIT_FOR_AUDIO_MS)
                    continue
                }
                offset += read
                socket.send(if (read == buffer.size) buffer.copyOf() else buffer.copyOf(read))
                delay(minimumChunkIntervalMs.toLong())
            }
        }
    }

    private fun watch(
        backendUrl: String,
        accessToken: String,
        referenceId: String,
        transcript: CompletableDeferred<TranscriptUpdate>,
    ): EventSource {
        val request =
            Request.Builder().url(BackendUrls.serverSentEvents(backendUrl, accessToken)).build()
        return EventSources.createFactory(client).newEventSource(
            request,
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    when (val update = TranscriptEvents.parse(data, referenceId)) {
                        is TranscriptUpdate.Final, is TranscriptUpdate.Failed ->
                            transcript.complete(update)
                        is TranscriptUpdate.Partial ->
                            store.update(referenceId) { it.copy(transcript = update.text) }
                        null -> Unit
                    }
                }
            },
        )
    }

    companion object {
        private const val TAG = "TranscriptionUploader"
        private const val CHUNK_BYTES = 3200 // 100 ms at 16 kHz / 16-bit / mono
        private const val WAIT_FOR_AUDIO_MS = 40L
        private const val MAX_SPEED_MULTIPLIER = 8
        private const val FINAL_TIMEOUT_MS = 30_000L

        private val client = OkHttpClient()
    }
}
