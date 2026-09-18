package com.dtinth.vxbeamer.mobile

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
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
    suspend fun upload(recording: Recording, captureFinished: () -> Boolean) {
        val attempt = recording.attempts + 1
        // A *new* reference id per attempt, not the recording's own. The
        // backend makes a fresh message for every `/ws` connect while keeping
        // whatever reference id it was given, so reusing one let a previous
        // attempt's events land on this one: an abandoned attempt's
        // "client disconnected" error would arrive mid-retry and fail a
        // perfectly healthy upload (dtinth/vxbeamer#86).
        val referenceId = "${recording.id}#$attempt"

        store.update(recording.id) {
            it.copy(
                status = RecordingStatus.UPLOADING,
                attempts = attempt,
                lastAttemptAt = System.currentTimeMillis(),
                error = null,
            )
        }

        var socket: BackendWebSocket? = null
        var events: EventSource? = null
        val transcript = CompletableDeferred<TranscriptUpdate>()

        try {
            val accessToken = authStore.currentAccessToken()
            val backendUrl = authStore.backendUrl
            socket = BackendWebSocket.connect(
                BackendUrls.webSocket(backendUrl, accessToken, referenceId, clientId),
            )
            events = watch(backendUrl, accessToken, referenceId, recording.id, transcript)

            PcmTail.stream(store.audioFile(recording), captureFinished) { socket.send(it) }
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
        } catch (cancellation: CancellationException) {
            // Not a failure: the queue is shutting down or this upload was
            // superseded. Leaving the status alone lets `reconcile` put it
            // back in the queue on the next start.
            socket?.abort()
            throw cancellation
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

    private fun watch(
        backendUrl: String,
        accessToken: String,
        referenceId: String,
        recordingId: String,
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
                        // In memory only: partials arrive several times a
                        // second and are worthless after a restart.
                        is TranscriptUpdate.Partial ->
                            store.updateInMemory(recordingId) { it.copy(transcript = update.text) }
                        null -> Unit
                    }
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    // Without this the transcript can never arrive and the
                    // upload just burns the whole timeout before reporting a
                    // misleading "timed out".
                    transcript.complete(
                        TranscriptUpdate.Failed(
                            t?.message ?: "Lost the connection while waiting for the transcript",
                        ),
                    )
                }
            },
        )
    }

    companion object {
        private const val TAG = "TranscriptionUploader"
        private const val FINAL_TIMEOUT_MS = 30_000L

        private val client = OkHttpClient()
    }
}
