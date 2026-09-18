package com.dtinth.vxbeamer.mobile

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.Log
import androidx.annotation.RequiresPermission
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Owns recording for the whole app: the microphone, the stored recordings,
 * and the queue that gets them transcribed.
 *
 * A singleton because there is one microphone and one queue, but several
 * surfaces driving them — the full screen, the floating button, the
 * picture-in-picture window and the Quick Settings tile — and all of them
 * have to agree about what is happening (dtinth/vxbeamer#86).
 *
 * **Capture never waits for the network.** Tapping record opens the mic and
 * writes to disk; an upload runs alongside, tailing that file. If it fails,
 * the recording is still on the device and gets retried, by the queue or by
 * hand. Stopping is likewise immediate — it closes the mic, and whatever
 * still needs sending is the queue's problem, not the user's.
 */
object Recorder {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private lateinit var appContext: Context
    private lateinit var uploader: TranscriptionUploader

    lateinit var store: RecordingStore
        private set

    private val _capturingId = MutableStateFlow<String?>(null)

    /** The recording being captured right now, if any. */
    val capturingId: StateFlow<String?> = _capturingId.asStateFlow()

    private val _audioLevel = MutableStateFlow(0f)

    /** Rough mic loudness, 0..1, while capturing; 0 otherwise. */
    val audioLevel: StateFlow<Float> = _audioLevel.asStateFlow()

    val isCapturing: Boolean
        get() = _capturingId.value != null

    private var pumpJob: Job? = null
    private var captureJob: Job? = null

    /** Set by the capture coroutine, applied once the recording is filed. */
    @Volatile
    private var captureError: String? = null
    private var initialized = false

    @Synchronized
    fun initialize(context: Context) {
        if (initialized) return
        initialized = true
        appContext = context.applicationContext
        store = RecordingStore(appContext.filesDir.resolve("recordings"))
        store.load()
        uploader =
            TranscriptionUploader(
                store = store,
                authStore = AuthStore(appContext),
                clientId = BackendWebSocket.CLIENT_ID,
                onTranscript = ::onTranscriptArrived,
            )
        startPump()
    }

    /**
     * Opens the mic and starts sending. Returns the new recording's id, or
     * null if one is already in progress.
     */
    @Synchronized
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    fun startCapture(): String? {
        if (isCapturing) return null
        // The previous capture still owns the AudioRecord until its own
        // teardown finishes — at least one blocking read later. Starting a
        // second one inside that window fails to initialise, so a quick
        // stop-then-start would lose the microphone (dtinth/vxbeamer#86).
        captureJob?.let { if (it.isActive) return null }

        val recording = store.beginRecording(UUID.randomUUID().toString(), System.currentTimeMillis())
        _capturingId.value = recording.id

        // Distinct from the stop flag on purpose. The capture loop tests that
        // flag *before* each read, so it still writes one more chunk after it
        // flips; an uploader that treated the flag as "no more audio" stopped
        // one chunk early and truncated the end of every recording. This is
        // only completed once the file is closed.
        val captureFinished = CompletableDeferred<Unit>()

        captureJob =
            scope.launch {
                // The upload tails the same file capture is writing, so the
                // transcript arrives as promptly as it would have from a live
                // socket — but the audio is on disk either way.
                val liveUpload = launch {
                    uploader.upload(recording) { captureFinished.isCompleted }
                }
                try {
                    AudioCapture.record(
                        file = store.audioFile(recording),
                        shouldContinue = { _capturingId.value == recording.id },
                        onLevel = { _audioLevel.value = it },
                    )
                } catch (t: Throwable) {
                    Log.e(TAG, "Capture failed", t)
                    captureError = t.message ?: t.javaClass.simpleName
                } finally {
                    captureFinished.complete(Unit)
                    _audioLevel.value = 0f
                    // Before clearing the capturing flag: that flag is what the
                    // service watches to decide whether it can stop, and it must
                    // not see "idle" while this recording is still being filed.
                    store.finishCapture(recording.id)
                    captureError?.let { message ->
                        store.update(recording.id) {
                            if (it.status == RecordingStatus.DONE) it
                            else it.copy(status = RecordingStatus.FAILED, error = message)
                        }
                        captureError = null
                    }
                    if (_capturingId.value == recording.id) _capturingId.value = null
                }
                liveUpload.join()
            }
        return recording.id
    }

    /** Closes the mic. Anything still to send is left to the queue. */
    fun stopCapture() {
        _capturingId.value = null
    }

    /**
     * Sends a recording again — a bad transcript, or one that never arrived.
     * Fails loudly if the audio has been pruned, rather than queueing an
     * upload that can only ever throw.
     */
    fun retry(id: String) {
        val recording = store.get(id) ?: return
        if (!store.audioFile(recording).exists()) {
            store.update(id) {
                it.copy(status = RecordingStatus.FAILED, error = "The audio is no longer on this device")
            }
            return
        }
        store.requeue(id)
    }

    /** Drops a recording and its audio. */
    fun discard(id: String) {
        store.delete(id)
    }

    fun copyToClipboard(text: String) {
        val clipboard = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        clipboard?.setPrimaryClip(ClipData.newPlainText("Transcript", text))
    }

    /**
     * Android only honours a clipboard write from an app that has focus, so
     * this quietly does nothing when a transcript lands while the user is in
     * another app. The transcript is in the history either way, where it can
     * always be copied by tapping it (dtinth/vxbeamer#86).
     */
    private fun onTranscriptArrived(text: String) {
        copyToClipboard(text)
    }

    /** Drains the queue: anything pending, then anything worth retrying. */
    private fun startPump() {
        if (pumpJob?.isActive == true) return
        pumpJob =
            scope.launch {
                while (isActive) {
                    val next = UploadPolicy.nextToUpload(store.recordings.value)
                    if (next != null) {
                        // Queued work is never the live recording, so its file
                        // is complete: nothing to wait for.
                        uploader.upload(next) { true }
                        continue
                    }
                    delay(PUMP_INTERVAL_MS)
                    // Nothing queued — give transient failures another go, once
                    // each has been left alone long enough (see the backoff in
                    // UploadPolicy).
                    val now = System.currentTimeMillis()
                    for (recording in UploadPolicy.automaticRetries(store.recordings.value, now)) {
                        store.update(recording.id) { it.copy(status = RecordingStatus.PENDING) }
                    }
                }
            }
    }

    private const val TAG = "Recorder"
    private const val PUMP_INTERVAL_MS = 10_000L
}
